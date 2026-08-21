/**
 * Auth-token bootstrap.
 *
 * Ensures `${XDG_CONFIG_HOME:-$HOME/.config}/obsidian-headless/auth_token`
 * exists with the correct content and tight POSIX modes (parent dir `0700`,
 * file `0600`) before any `ob` child is spawned. Idempotent — a second call
 * with the same env value is a no-op (file mtime preserved).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Thrown when neither `OBSIDIAN_AUTH_TOKEN` nor an on-disk auth_token file
 * is available. Maps to exit code 78 (`EX_CONFIG`) — see the error taxonomy
 * in `docs/specs/obsidian-sync/index.md`.
 */
export class AuthMissingError extends Error {
  readonly exitCode = 78;
  constructor(message: string) {
    super(message);
    this.name = "AuthMissingError";
  }
}

export interface BootstrapInput {
  /** Resolved value of `OBSIDIAN_AUTH_TOKEN`, or `undefined` if unset. */
  readonly authToken: string | undefined;
  /**
   * `XDG_CONFIG_HOME` if set. Empty / whitespace-only values are treated as
   * unset (an empty string would otherwise produce a relative path under the
   * current working directory).
   */
  readonly xdgConfigHome?: string;
  /**
   * Process owner's home directory; used when `xdgConfigHome` is unset.
   * Empty / whitespace-only values are treated as unset.
   */
  readonly homeDir?: string;
}

export interface BootstrapResult {
  readonly path: string;
  readonly action: "wrote" | "unchanged";
}

/**
 * File-system surface this module needs. Real implementation uses Node's
 * `fs/promises`; tests inject a stub when they need to drive specific error
 * shapes (e.g. `chmod` not supported on the host fs).
 */
export interface BootstrapFs {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const defaultFs: BootstrapFs = {
  mkdir: (p, opts) => mkdir(p, opts).then(() => undefined),
  readFile: (p, enc) => readFile(p, enc),
  writeFile: (p, data, opts) => writeFile(p, data, opts),
  chmod: (p, mode) => chmod(p, mode),
};

function trimToUndefined(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Resolve the XDG config base — `${XDG_CONFIG_HOME:-${HOME:-/home/ob}/.config}`
 * minus the container default, which the caller supplies as `homeDir`.
 *
 * Returns `null` when neither input resolves to a non-empty path;
 * `path.join("", "obsidian-headless")` would otherwise produce a relative
 * path against the process's CWD, which is the footgun this guard closes.
 *
 * This is the single definition of the base. Everything the supervisor keeps
 * under it — the credential file and the per-vault `obsidian-headless/sync/`
 * tree the stall watchdog reads — MUST resolve it through this function, so
 * the two can never search different trees.
 */
export function resolveXdgConfigBase(
  input: Pick<BootstrapInput, "xdgConfigHome" | "homeDir">,
): string | null {
  const xdg = trimToUndefined(input.xdgConfigHome);
  if (xdg !== undefined) return xdg;
  const home = trimToUndefined(input.homeDir);
  return home === undefined ? null : join(home, ".config");
}

/**
 * Resolve the absolute auth_token path the supervisor will write to.
 *
 * Throws `AuthMissingError` if neither `xdgConfigHome` nor `homeDir`
 * resolves to a non-empty path.
 */
export function resolveAuthTokenPath(
  input: Pick<BootstrapInput, "xdgConfigHome" | "homeDir">,
): string {
  const root = resolveXdgConfigBase(input);
  if (root === null) {
    throw new AuthMissingError(
      "neither XDG_CONFIG_HOME nor HOME resolves to a non-empty path; cannot locate auth_token",
    );
  }
  return join(root, "obsidian-headless", "auth_token");
}

function isNodeErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === "object" && e !== null && "code" in e;
}

/**
 * Ensure the auth_token file is present and matches the env value.
 *
 * Behaviour matrix:
 * - env set, file missing            → write file (parent 0700, file 0600).
 * - env set, file matches            → re-harden modes (parent 0700, file 0600), preserve mtime.
 * - env set, file differs            → overwrite + chmod 0600.
 * - env unset, file present          → re-harden modes (mounted-volume case).
 * - env unset, file missing          → throw `AuthMissingError`.
 *
 * The "unchanged" paths still re-`chmod` the file and parent dir because a
 * mounted token volume can ship with looser permissions (e.g. `0644`) and we
 * MUST NOT leave a credential world-readable just because the contents
 * happened to match.
 */
export async function ensureAuthToken(
  input: BootstrapInput,
  fs: BootstrapFs = defaultFs,
): Promise<BootstrapResult> {
  const tokenPath = resolveAuthTokenPath(input);
  const parent = dirname(tokenPath);

  let existing: string | undefined;
  try {
    existing = await fs.readFile(tokenPath, "utf8");
  } catch (e) {
    if (!isNodeErrnoException(e) || e.code !== "ENOENT") throw e;
    existing = undefined;
  }

  const env = input.authToken;

  // Helper to re-apply the strict POSIX modes without rewriting the file.
  // Always idempotent — chmod a file and dir already at 0600/0700 is a no-op.
  const reHarden = async (): Promise<void> => {
    await fs.chmod(parent, 0o700);
    await fs.chmod(tokenPath, 0o600);
  };

  if (env === undefined || env === "") {
    if (existing !== undefined) {
      await reHarden();
      return { path: tokenPath, action: "unchanged" };
    }
    throw new AuthMissingError(`OBSIDIAN_AUTH_TOKEN is required (or mount ${tokenPath})`);
  }

  if (existing === env) {
    await reHarden();
    return { path: tokenPath, action: "unchanged" };
  }

  // Either no file, or contents differ — write through.
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, env, { mode: 0o600 });
  // Some hosts ignore the `mode` arg to writeFile when the file already
  // exists with a different mode; chmod explicitly to be safe.
  await fs.chmod(tokenPath, 0o600);
  await fs.chmod(parent, 0o700);
  return { path: tokenPath, action: "wrote" };
}
