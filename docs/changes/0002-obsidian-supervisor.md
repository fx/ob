# 0002: Obsidian Supervisor

## Summary

Implement the auth-token bootstrap and the per-vault `obsidian-headless` supervisor. After this change, starting the container with a valid token and `VAULTS_JSON` results in one healthy `ob sync --continuous` child per vault, with crash-restart, structured logs tagged by vault, and a clean SIGTERM path.

**Spec:** [Obsidian Sync](../specs/obsidian-sync/)
**Status:** complete
**Depends On:** 0001

## Motivation

Without a working supervisor, there is no on-disk vault for the indexer to read or for the REST API to write to. This is the critical-path piece between credentials and a usable system; everything else builds on the on-disk working tree it produces.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- All tests run under `bun test`; coverage MUST stay at 100% line + branch on `src/`.
- The `ob` binary MUST NOT be invoked against real Obsidian servers in tests. Spawn calls MUST go through a `Spawner` interface that defaults to `Bun.spawn` and is replaced with a fake in unit tests.
- One integration test MUST `Bun.spawn(["ob", "--help"])` and assert exit 0 to verify the binary is installed in the dev/CI image. This test MUST be guarded by a `OB_BIN` env or a `it.skipIf(!hasOb())` so a developer without `ob` installed can still run the suite locally.
- File operations on the auth_token file MUST run against `Bun.tmpdirSync()` directories — never the real `~/.config`.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Auth-token bootstrap

- `src/obsidian/bootstrap.ts` MUST export `ensureAuthToken(cfg, fs?): Promise<void>`.
- It MUST resolve the target path as `${cfg.xdgConfigHome ?? cfg.homeDir + "/.config"}/obsidian-headless/auth_token`.
- It MUST `mkdir -p` the parent with mode `0700` (rwx user only) and write the token with mode `0600`.
- It MUST be idempotent: a second call with the same env value MUST be a no-op (no rewrite if contents match).
- It MUST overwrite the file when env value differs from on-disk content.

#### Scenario: Empty config dir, env present

- **GIVEN** a tmpdir as fake `XDG_CONFIG_HOME`, `OBSIDIAN_AUTH_TOKEN=abc`
- **WHEN** `ensureAuthToken` runs
- **THEN** `<tmp>/obsidian-headless/auth_token` exists with content `abc` and mode `0600`
- **AND** the parent dir exists with mode `0700`

#### Scenario: Token file already matches

- **GIVEN** the file exists with content `abc` and `OBSIDIAN_AUTH_TOKEN=abc`
- **WHEN** `ensureAuthToken` runs
- **THEN** `mtime` of the file is unchanged

#### Scenario: Both unset

- **GIVEN** `OBSIDIAN_AUTH_TOKEN` unset and the file does not exist
- **WHEN** `ensureAuthToken` runs
- **THEN** it throws `AuthMissingError`

### Supervisor

- `src/obsidian/index.ts` MUST export `startSupervisor(cfg, deps?): Promise<Supervisor>` matching the public surface in the spec.
- For each vault: ensure `<DATA_DIR>/vaults/<slug>/`, run setup if needed, then spawn `ob sync --continuous --path <dir>`.
- Setup detection: call `ob sync-status --path <dir>`; exit 0 means configured. If non-zero, run `ob sync-setup --vault "<name>" --path <dir>` (with `--password` if set), retry per backoff.
- Each child's stdout and stderr MUST be line-split and forwarded as `info`/`warn` log lines with `{vault, source: "ob", stream: "stdout|stderr"}`.
- Crash restart: ≤ 60 s capped exponential backoff, restart counter resets after 5 minutes of healthy uptime.
- Crash-loop ceiling: ≥ 10 crashes within 5 minutes flips the vault to `failed` and stops restart attempts for that vault only.
- `Supervisor.stop()` MUST SIGTERM all children in parallel, await up to 5 s each, SIGKILL survivors, and resolve.

#### Scenario: First-start, fresh dir

- **GIVEN** clean tmp `DATA_DIR`, `VAULTS_JSON=[{"name":"v"}]`, fake spawner
- **WHEN** `startSupervisor` runs
- **THEN** `mkdir` of `<tmp>/vaults/v` is observed
- **AND** the spawner records exactly one `ob sync-setup --vault v --path <tmp>/vaults/v` call before any `ob sync` call

#### Scenario: Crash-loop detection

- **GIVEN** a fake spawner whose `ob sync` child exits with code 1 immediately
- **WHEN** the supervisor has been running long enough for 10 crashes
- **THEN** the spawner records exactly 10 `ob sync` invocations
- **AND** `Supervisor.list()[0].state === "failed"`

#### Scenario: Graceful shutdown

- **GIVEN** two healthy fake children
- **WHEN** `Supervisor.stop()` is awaited
- **THEN** both children received SIGTERM
- **AND** the call resolves within 6 s of the slowest child exit

### Wiring

- `src/server.ts` MUST call `ensureAuthToken` then `startSupervisor` before `Bun.serve` opens the port.
- `GET /healthz` MUST stay 200 once the listener is open.
- `GET /readyz` (new in this PR) MUST return 200 only when every supervised vault state is `running`. Otherwise 503 with `{ vaults: VaultStatus[] }`.

## Design

### Approach

- Keep the supervisor purely state-machine. No `ob` knowledge inside `child.ts` beyond "spawn this command, restart on exit, count crashes."
- A small `Spawner` interface lets unit tests inject deterministic fake processes:
  ```ts
  interface Spawner {
    run(cmd: string, args: string[], opts: SpawnOpts): SpawnHandle;
  }
  interface SpawnHandle {
    pid: number | null;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal: NodeJS.Signals): void;
  }
  ```
- Time MUST be injectable too (`now()` and `setTimeout` wrapped) so the crash-loop window is testable without sleeps.

### Decisions

- **Per-vault child, not one multiplexed child**: `ob sync --continuous` takes a single `--path`. Cleanest to run one per vault; restart isolation also cleaner.
  - Alternatives: build a wrapper that opens `ob` once per vault sequentially in a loop — fragile, no parallel sync.
- **Detect setup via `ob sync-status` exit code, not file existence**: avoids guessing the exact filename inside `.obsidian/` (which the upstream may rename).
  - Alternatives: assume `<dir>/.obsidian/sync.json` — brittle.
- **`Bun.spawn` over `child_process.spawn`**: stays Bun-native. If signal semantics differ on Linux (`Bun.spawn` historically lagged Node here), revisit during implementation; the `Spawner` abstraction makes the swap cheap.

### Non-Goals

- No `sync-config` overrides (sync mode, file types, excluded folders) in v1.
- No `sync-create-remote`. Creating a remote vault is a one-time operator action.
- No metrics in this PR (added with `/metrics` later).

## Tasks

- [x] **Auth bootstrap** — `src/obsidian/bootstrap.ts` + tests covering all three scenarios above.
- [x] **Spawner abstraction & fake** — `src/obsidian/spawn.ts` (real) + `test/helpers/fakeSpawner.ts`.
- [x] **Status detection** — `src/obsidian/status.ts` parsing `ob sync-status` exit codes + tests with the fake spawner.
- [x] **Setup orchestration** — `src/obsidian/setup.ts` with backoff + tests covering: succeeds first try, retries 3× then succeeds, fails 5× → permanent.
- [x] **Per-vault child loop** — `src/obsidian/child.ts` covering: spawn, log forwarding, restart with backoff, crash-loop ceiling, graceful stop.
- [x] **Supervisor facade** — `src/obsidian/index.ts` orchestrating bootstrap → setup → child per vault, exposing `Supervisor` API.
- [x] **Wire into server** — call from `src/server.ts`, add `/readyz`, ensure SIGTERM stops the supervisor.
- [x] **`ob` binary smoke test** — single integration test that runs `ob --help`; gated by `OB_BIN` env.
- [x] **Coverage 100%** — including all error branches.

## Open Questions

- [ ] **`Bun.spawn` SIGTERM behavior on Alpine glibc/musl.** If the child doesn't receive SIGTERM cleanly, fall back to `child_process.spawn` inside the real `Spawner` implementation. The interface stays unchanged.
- [ ] **`ob sync-status` JSON output.** Confirm whether a `--json` flag exists or is being added upstream. If yes, switch to it for richer status; if not, exit-code parsing is sufficient.
- [ ] **Concurrent setup of N vaults.** Run setups in parallel or serially? Serial is safer (one auth handshake at a time) and N is small. **Default**: serial.

## References

- Spec: [Obsidian Sync](../specs/obsidian-sync/)
- Related changes: [0001-project-scaffold](./0001-project-scaffold.md)
- [obsidianmd/obsidian-headless README](https://github.com/obsidianmd/obsidian-headless)
