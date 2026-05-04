/**
 * Single integration test that verifies the `ob` binary is installed and
 * runnable in the dev/CI image. Gated by `OB_BIN` env or a positive
 * `Bun.which("ob")` so a developer running `bun test` without the
 * upstream CLI installed simply skips it instead of failing.
 *
 * The dev container ships without `obsidian-headless`, so this test is
 * expected to skip locally; it's the production image (Change 0006) that
 * makes it pass.
 */

import { describe, expect, it } from "bun:test";

async function obAvailable(): Promise<boolean> {
  if (process.env.OB_BIN !== undefined && process.env.OB_BIN !== "") return true;
  // Bun.which returns null when the binary isn't on PATH.
  return Bun.which("ob") !== null;
}

const available = await obAvailable();

describe("ob binary smoke", () => {
  it.skipIf(!available)("`ob --help` exits 0", async () => {
    const bin = process.env.OB_BIN ?? "ob";
    const proc = Bun.spawn([bin, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
