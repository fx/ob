/**
 * End-to-end test for the production Docker image.
 *
 * Gated behind `DOCKER_E2E=1` so the default `bun test` suite skips it
 * cleanly (no docker daemon required, no privileged calls). When the gate is
 * set, the test:
 *
 *   1. Builds `ob:test` from the repo root — UNLESS `OB_IMAGE_PREBUILT=1`
 *      is set, in which case the image is assumed to already exist in the
 *      local daemon (CI workflow `docker.yml` builds it once via
 *      build-push-action and re-tags it `ob:test` for this test).
 *   2. Runs `ob --help` inside the image and asserts it succeeded and
 *      mentions the `sync` subcommand (per change 0006 acceptance scenario
 *      "Built image runs `ob`").
 *   3. Runs `id -u` inside the image and asserts it prints `1000` (per
 *      acceptance scenario "Image is rootless").
 *
 * Each docker invocation is wrapped in `sudo` because the dev container
 * exposes the docker socket only to root. Override via `OB_DOCKER` /
 * `OB_DOCKER_SUDO` if your environment doesn't need elevation. Setting
 * `OB_DOCKER_SUDO=""` (or any whitespace-only value) disables the prefix
 * entirely — the test then runs `docker ...` directly.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const E2E_ENABLED = process.env.DOCKER_E2E === "1";
const PREBUILT = process.env.OB_IMAGE_PREBUILT === "1";
const DOCKER = process.env.OB_DOCKER ?? "docker";
const IMAGE_TAG = "ob:test";

/**
 * Resolve the optional `sudo` (or equivalent) prefix.
 *
 * `process.env.OB_DOCKER_SUDO ?? "sudo"` would preserve an empty string,
 * causing `Bun.spawn(["", "docker", ...])` to fail before docker runs.
 * Treat any unset OR whitespace-only value as "no prefix"; otherwise use
 * the trimmed value as the prefix command.
 */
const SUDO_PREFIX: readonly string[] = (() => {
  const raw = process.env.OB_DOCKER_SUDO;
  if (raw === undefined) return ["sudo"];
  const trimmed = raw.trim();
  return trimmed === "" ? [] : [trimmed];
})();

function dockerCmd(...args: readonly string[]): readonly string[] {
  return [...SUDO_PREFIX, DOCKER, ...args];
}

/** Long timeout — the cold build pulls ~2 GB of base images. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** Short — we're only running `ob --help` and `id`. */
const RUN_TIMEOUT_MS = 60 * 1000;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: readonly string[], timeoutMs: number): Promise<RunResult> {
  const proc = Bun.spawn(cmd as string[], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

describe("docker image (DOCKER_E2E=1)", () => {
  it.skipIf(!E2E_ENABLED || PREBUILT)(
    "builds the production image",
    async () => {
      const r = await run(dockerCmd("build", "-t", IMAGE_TAG, "."), BUILD_TIMEOUT_MS);
      expect(r.exitCode, `build failed:\n${r.stderr}`).toBe(0);
    },
    BUILD_TIMEOUT_MS + 30_000,
  );

  it.skipIf(!E2E_ENABLED)(
    "exposes the `ob` binary on PATH (acceptance: built image runs `ob`)",
    async () => {
      const r = await run(dockerCmd("run", "--rm", IMAGE_TAG, "ob", "--help"), RUN_TIMEOUT_MS);
      expect(r.exitCode, `ob --help failed:\n${r.stderr}`).toBe(0);
      // Per change 0006 acceptance ("Built image runs `ob`"): the help
      // output proves both that the program is `ob` (Usage: ob…) and that
      // the `sync` subcommand is present. obsidian-headless renders these
      // on separate lines, so we assert each piece independently.
      expect(r.stdout).toContain("Usage: ob");
      expect(r.stdout).toMatch(/^\s+sync\b/m);
    },
    RUN_TIMEOUT_MS + 5_000,
  );

  it.skipIf(!E2E_ENABLED)(
    "runs as uid 1000 (acceptance: image is rootless)",
    async () => {
      const r = await run(dockerCmd("run", "--rm", IMAGE_TAG, "id", "-u"), RUN_TIMEOUT_MS);
      expect(r.exitCode, `id -u failed:\n${r.stderr}`).toBe(0);
      expect(r.stdout.trim()).toBe("1000");
    },
    RUN_TIMEOUT_MS + 5_000,
  );
});
