/**
 * Integration test for the `import.meta.main` guard at the bottom of
 * `src/server.ts`. The guard cannot be reached by importing the module from
 * a unit test (Bun sets `import.meta.main` based on the program entrypoint),
 * so we drive it the way it's actually used: by spawning `bun src/server.ts`
 * as a child process and observing its behavior.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER_ENTRY = resolve(import.meta.dir, "..", "src", "server.ts");

function tmpHomeEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ob-entry-"));
  return {
    XDG_CONFIG_HOME: dir,
    HOME: dir,
    DATA_DIR: join(dir, "data"),
  };
}

interface SpawnedServer {
  readonly proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

async function readUntilListening(
  proc: import("bun").Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs = 5000,
): Promise<number> {
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // The logger emits "server listening" with a port field as JSON-per-line.
      const line = buf.split("\n").find((l) => l.includes('"server listening"'));
      if (line !== undefined) {
        const parsed = JSON.parse(line) as { port?: number };
        if (typeof parsed.port === "number") return parsed.port;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`server did not log "server listening" within ${timeoutMs}ms; got: ${buf}`);
}

async function spawnServer(env: Record<string, string>): Promise<SpawnedServer> {
  const proc = Bun.spawn(["bun", SERVER_ENTRY], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const port = await readUntilListening(proc);
  const stop = async (): Promise<void> => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await proc.exited;
  };
  return { proc, port, stop };
}

describe("src/server.ts entrypoint (import.meta.main guard)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const fn of cleanup) await fn();
  });

  test("boots when invoked directly and serves /healthz", async () => {
    const s = await spawnServer({
      OBSIDIAN_AUTH_TOKEN: "tk",
      VAULTS_JSON: '[{"name":"entry"}]',
      HTTP_PORT: "0",
      HTTP_HOST: "127.0.0.1",
      LOG_LEVEL: "info",
      ...tmpHomeEnv(),
    });
    cleanup.push(s.stop);
    const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await s.stop();
    // SIGTERM-driven shutdown should yield exit code 0.
    expect(s.proc.exitCode).toBe(0);
  }, 15_000);

  test("exits 78 when invoked directly with bad config", async () => {
    const proc = Bun.spawn(["bun", SERVER_ENTRY], {
      env: {
        ...process.env,
        OBSIDIAN_AUTH_TOKEN: "",
        VAULTS_JSON: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(78);
  }, 15_000);
});
