/**
 * Tests for `src/obsidian/status.ts`. Uses the fake spawner so no real
 * `ob` binary is required.
 */

import { describe, expect, test } from "bun:test";
import { checkSetupStatus } from "../../src/obsidian/status.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";

describe("checkSetupStatus", () => {
  test("exit 0 → 'configured'", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    const status = await checkSetupStatus(sp, { path: "/tmp/v" });
    expect(status).toBe("configured");
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.cmd).toBe("ob");
    expect(sp.calls[0]?.args).toEqual(["sync-status", "--path", "/tmp/v"]);
  });

  test("exit non-zero → 'not-configured'", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 2, stderr: ["not configured"] });
    const status = await checkSetupStatus(sp, { path: "/tmp/v" });
    expect(status).toBe("not-configured");
  });

  test("respects custom obBin", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    await checkSetupStatus(sp, { path: "/tmp/v", obBin: "/usr/local/bin/ob" });
    expect(sp.calls[0]?.cmd).toBe("/usr/local/bin/ob");
  });

  test("drains stdout content without blocking", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({
      exitCode: 0,
      stdout: ["line1", "line2", "line3"],
      stderr: ["err1"],
    });
    const status = await checkSetupStatus(sp, { path: "/tmp/v" });
    expect(status).toBe("configured");
  });
});
