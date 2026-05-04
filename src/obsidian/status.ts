/**
 * `ob sync-status` exit-code parser.
 *
 * Per the spec we treat exit 0 as "vault is configured" and any non-zero as
 * "needs setup". This is intentionally exit-code-only (not output parsing);
 * the upstream tool may add a `--json` flag later (open question in the
 * change doc), at which point this module is the single place to upgrade.
 */

import type { Spawner } from "./spawn.ts";

export type SetupStatus = "configured" | "not-configured";

export interface CheckStatusInput {
  readonly path: string;
  readonly obBin?: string;
}

/** Drain a stream into a string. Used to consume stdout/stderr we don't log. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run `ob sync-status --path <dir>` and return whether the vault is
 * already set up. Errors from spawning the binary itself propagate
 * to the caller (they're indistinguishable from "not configured" only
 * when the binary actually executed and reported a non-zero exit).
 */
export async function checkSetupStatus(
  spawner: Spawner,
  input: CheckStatusInput,
): Promise<SetupStatus> {
  const obBin = input.obBin ?? "ob";
  const handle = spawner.run(obBin, ["sync-status", "--path", input.path]);
  // Drain stdout/stderr in parallel so the child can flush and exit cleanly
  // even when the buffers fill up.
  const [, , code] = await Promise.all([drain(handle.stdout), drain(handle.stderr), handle.exited]);
  return code === 0 ? "configured" : "not-configured";
}
