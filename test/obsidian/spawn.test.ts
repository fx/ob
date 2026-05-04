/**
 * Tests for the real `Bun.spawn`-backed spawner.
 *
 * Uses harmless built-in commands (`true`, `false`, `printf`, `cat`,
 * a non-existent binary) — no `ob` calls. The supervisor-level integration
 * smoke test that does invoke `ob --help` lives in `test/obsidian/ob-smoke.test.ts`
 * and is gated by `OB_BIN` / `Bun.which`.
 */

import { describe, expect, test } from "bun:test";
import { buildRealSpawner, realSpawner, spawnFailedHandle } from "../../src/obsidian/spawn.ts";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Buffer.concat's recent type signature on Bun expects a strict
  // `Uint8Array<ArrayBuffer>[]`. Buffer instances widen to
  // `Uint8Array<ArrayBufferLike>` (SAB-compatible), which the type guard
  // rejects. The runtime accepts both — cast through the narrower view.
  const views = chunks.map((c) => new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
  return Buffer.concat(views).toString("utf8");
}

describe("realSpawner", () => {
  test("runs `true` and exits 0", async () => {
    const handle = realSpawner.run("true", []);
    expect(typeof handle.pid === "number" || handle.pid === null).toBe(true);
    const code = await handle.exited;
    expect(code).toBe(0);
    // Drain streams to avoid lingering resources.
    await readAll(handle.stdout);
    await readAll(handle.stderr);
  });

  test("runs `false` and exits non-zero", async () => {
    const handle = realSpawner.run("false", []);
    const code = await handle.exited;
    expect(code).not.toBe(0);
    await readAll(handle.stdout);
    await readAll(handle.stderr);
  });

  test("captures stdout from `printf`", async () => {
    const handle = realSpawner.run("printf", ["hello"]);
    const out = await readAll(handle.stdout);
    await readAll(handle.stderr);
    await handle.exited;
    expect(out).toBe("hello");
  });

  test("merges and prunes opts.env (including undefined values)", async () => {
    const handle = realSpawner.run("printenv", ["OB_TEST_VAR"], {
      env: { OB_TEST_VAR: "hello", OB_UNSET_VAR: undefined },
    });
    const out = await readAll(handle.stdout);
    await readAll(handle.stderr);
    await handle.exited;
    expect(out.trim()).toBe("hello");
  });

  test("synthetic-fail path: spawn injection that throws maps to exit 127 + stderr message", async () => {
    const sp = buildRealSpawner({
      spawn: () => {
        throw new Error("ENOENT: no such binary");
      },
    });
    const handle = sp.run("nope", []);
    expect(handle.pid).toBeNull();
    const code = await handle.exited;
    expect(code).toBe(127);
    await readAll(handle.stdout);
    const err = await readAll(handle.stderr);
    expect(err).toContain("ENOENT");
    // Kill is a no-op on the synthetic handle.
    expect(() => handle.kill("SIGTERM")).not.toThrow();
  });

  test("synthetic-fail path: non-Error throw stringifies", async () => {
    const sp = buildRealSpawner({
      spawn: () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error branch
        throw "raw error";
      },
    });
    const handle = sp.run("nope", []);
    const code = await handle.exited;
    expect(code).toBe(127);
    await readAll(handle.stdout);
    const err = await readAll(handle.stderr);
    expect(err).toContain("raw error");
  });

  test("spawnFailedHandle exposes empty stdout and synthetic stderr", async () => {
    const handle = spawnFailedHandle("boom");
    expect(handle.pid).toBeNull();
    expect(await readAll(handle.stdout)).toBe("");
    expect(await readAll(handle.stderr)).toContain("boom");
    expect(await handle.exited).toBe(127);
    expect(() => handle.kill("SIGTERM")).not.toThrow();
  });

  test("kill is a no-op after exit and does not throw (covers proc.kill throw branch)", async () => {
    const handle = realSpawner.run("true", []);
    await handle.exited;
    // Bun.spawn throws on kill of an already-exited process; the wrapper swallows it.
    expect(() => handle.kill("SIGTERM")).not.toThrow();
    // Calling again hits the same swallow path.
    expect(() => handle.kill("SIGKILL")).not.toThrow();
  });

  test("kill while running terminates the child", async () => {
    // `sleep 5` lets us send SIGTERM mid-flight.
    const handle = realSpawner.run("sleep", ["5"]);
    handle.kill("SIGTERM");
    const code = await handle.exited;
    // Bun reports negative or non-zero exit for signal-terminated children;
    // either way it MUST NOT be 0.
    expect(code).not.toBe(0);
    await readAll(handle.stdout);
    await readAll(handle.stderr);
  });

  test("inherits process.env unless overridden", async () => {
    const previous = process.env.OB_INHERITED;
    process.env.OB_INHERITED = "yes";
    try {
      const handle = realSpawner.run("printenv", ["OB_INHERITED"]);
      const out = await readAll(handle.stdout);
      await readAll(handle.stderr);
      await handle.exited;
      expect(out.trim()).toBe("yes");
    } finally {
      // biome-ignore lint/performance/noDelete: env vars must be removed entirely, not set to "undefined" (printenv would still emit them).
      if (previous === undefined) delete process.env.OB_INHERITED;
      else process.env.OB_INHERITED = previous;
    }
  });
});
