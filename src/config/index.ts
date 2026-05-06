/**
 * Environment-driven configuration loader.
 *
 * All runtime config flows through this module. The loader is pure: it takes a
 * `Record<string, string | undefined>` (typically `process.env`) and returns a
 * fully-validated `Config`, or throws `ConfigError` (exit code 78 — EX_CONFIG).
 */

export type EmbeddingProvider = "transformers" | "openai";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface VaultConfig {
  readonly name: string;
  readonly slug: string;
  readonly e2eePassword?: string;
}

/**
 * Resolved `OB_SYNC_*` env vars used by `applyVaultSyncConfig` to build the
 * `ob sync-config` argv. Each field is `string | undefined`:
 *
 * - `undefined` — the env var was unset; the corresponding flag MUST be
 *   omitted entirely (preserves on-disk value).
 * - `""` (empty string) — the env var was set to an empty string; the flag
 *   MUST be passed verbatim with an empty value (matches upstream "empty to
 *   clear" semantic).
 * - any non-empty string — the value to pass to the flag verbatim.
 */
export interface SyncConfigEnv {
  readonly fileTypes?: string;
  readonly excludedFolders?: string;
  readonly mode?: string;
  readonly conflictStrategy?: string;
  readonly deviceName?: string;
  readonly configs?: string;
}

export interface Config {
  /**
   * Value of `OBSIDIAN_AUTH_TOKEN`. OPTIONAL at the env layer because the
   * architecture spec allows a pre-existing `auth_token` file (e.g. a
   * mounted volume) to act as the credential source. The supervisor's
   * `ensureAuthToken` is the authoritative gate that errors out only when
   * BOTH the env value and the on-disk file are absent.
   */
  readonly obsidianAuthToken: string | undefined;
  readonly vaults: readonly VaultConfig[];
  readonly dataDir: string;
  readonly httpPort: number;
  readonly httpHost: string;
  readonly embeddingProvider: EmbeddingProvider;
  readonly embeddingModel: string;
  readonly openaiApiKey?: string;
  readonly openaiBaseUrl?: string;
  readonly logLevel: LogLevel;
  /**
   * Resolved `OB_SYNC_*` env vars (validated). All fields default to
   * `undefined` when the corresponding env var is unset; the supervisor
   * skips `ob sync-config` entirely when every field is `undefined`.
   */
  readonly syncConfigEnv: SyncConfigEnv;
}

/**
 * Thrown by `loadConfig` for any missing-required-or-invalid input.
 *
 * The recommended exit code (`78`, `EX_CONFIG` from sysexits) is exposed on the
 * instance so the entrypoint can `process.exit(err.exitCode)` without hard-coding.
 */
export class ConfigError extends Error {
  readonly exitCode = 78;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VALID_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];
const VALID_PROVIDERS: readonly EmbeddingProvider[] = ["transformers", "openai"];

const DEFAULT_TRANSFORMERS_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseVaults(raw: string): VaultConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`VAULTS_JSON is not valid JSON: ${msg}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError("VAULTS_JSON must be a non-empty JSON array of vault objects");
  }

  const vaults: VaultConfig[] = [];
  const seenSlugs = new Map<string, string>(); // slug -> first name that produced it

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!isPlainObject(entry)) {
      throw new ConfigError(`VAULTS_JSON[${i}] must be an object`);
    }
    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new ConfigError(`VAULTS_JSON[${i}].name must be a non-empty string`);
    }

    const slugRaw = entry.slug;
    let slug: string;
    if (slugRaw === undefined) {
      slug = slugify(name);
    } else if (typeof slugRaw === "string" && slugRaw.trim() !== "") {
      slug = slugify(slugRaw);
    } else {
      throw new ConfigError(`VAULTS_JSON[${i}].slug must be a non-empty string when provided`);
    }
    if (slug === "") {
      throw new ConfigError(`VAULTS_JSON[${i}] produced an empty slug from name="${name}"`);
    }

    const e2eeRaw = entry.e2eePassword;
    let e2eePassword: string | undefined;
    if (e2eeRaw !== undefined) {
      if (typeof e2eeRaw !== "string") {
        throw new ConfigError(`VAULTS_JSON[${i}].e2eePassword must be a string when provided`);
      }
      e2eePassword = e2eeRaw;
    }

    const prior = seenSlugs.get(slug);
    if (prior !== undefined) {
      throw new ConfigError(
        `VAULTS_JSON contains duplicate slug "${slug}" produced by names "${prior}" and "${name}"`,
      );
    }
    seenSlugs.set(slug, name);

    const vault: VaultConfig =
      e2eePassword === undefined ? { name, slug } : { name, slug, e2eePassword };
    vaults.push(vault);
  }

  return vaults;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`HTTP_PORT must be a non-negative integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  // 0 is allowed to mean "OS-assigned ephemeral port" — used in tests; in prod
  // operators should set a real port. 65535 is the upper bound.
  if (n < 0 || n > 65535) {
    throw new ConfigError(`HTTP_PORT must be between 0 and 65535, got ${n}`);
  }
  return n;
}

function parseLevel(raw: string): LogLevel {
  if ((VALID_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  throw new ConfigError(`LOG_LEVEL must be one of ${VALID_LEVELS.join("|")}, got "${raw}"`);
}

function parseProvider(raw: string): EmbeddingProvider {
  if ((VALID_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as EmbeddingProvider;
  }
  throw new ConfigError(
    `EMBEDDING_PROVIDER must be one of ${VALID_PROVIDERS.join("|")}, got "${raw}"`,
  );
}

const VALID_SYNC_FILE_TYPES: readonly string[] = ["image", "audio", "pdf", "video", "unsupported"];
const VALID_SYNC_MODES: readonly string[] = ["bidirectional", "pull-only", "mirror-remote"];
const VALID_SYNC_CONFLICT_STRATEGIES: readonly string[] = ["merge", "conflict"];
const VALID_SYNC_CONFIGS: readonly string[] = [
  "app",
  "appearance",
  "appearance-data",
  "hotkey",
  "core-plugin",
  "core-plugin-data",
  "community-plugin",
  "community-plugin-data",
];

/**
 * Validate a comma-separated list against an enum's allowed tokens. Whitespace
 * around tokens is trimmed before validation; the *value* still flows through
 * to the CLI verbatim because upstream `ob` accepts whitespace in lists.
 *
 * Empty strings are intentionally rejected here only when there is at least
 * one non-empty token that is invalid; the wholly-empty value (`""`) is
 * accepted by the caller and forwarded as the upstream "empty to clear"
 * sentinel.
 */
function validateCsvSubset(varName: string, raw: string, allowed: readonly string[]): void {
  if (raw === "") return;
  const tokens = raw.split(",").map((t) => t.trim());
  for (const tok of tokens) {
    if (tok === "" || !allowed.includes(tok)) {
      throw new ConfigError(
        `${varName} must be a comma-separated subset of ${allowed.join("|")} (or empty), got token "${tok}"`,
      );
    }
  }
}

function validateEnum(varName: string, raw: string, allowed: readonly string[]): void {
  if (raw === "") return;
  if (!allowed.includes(raw)) {
    throw new ConfigError(
      `${varName} must be one of ${allowed.join("|")} (or empty), got "${raw}"`,
    );
  }
}

/**
 * Resolve and validate the `OB_SYNC_*` env-var family. Returns a
 * `SyncConfigEnv` whose fields are either `undefined` (var unset → skip
 * flag), `""` (var set to empty → "empty to clear"), or a verbatim value.
 *
 * Throws `ConfigError` (exit 78) on any invalid enum value, naming the
 * offending var and the acceptable values.
 */
export function loadSyncConfigEnv(env: Record<string, string | undefined>): SyncConfigEnv {
  const fileTypes = env.OB_SYNC_FILE_TYPES;
  if (fileTypes !== undefined) {
    validateCsvSubset("OB_SYNC_FILE_TYPES", fileTypes, VALID_SYNC_FILE_TYPES);
  }
  const mode = env.OB_SYNC_MODE;
  if (mode !== undefined) {
    validateEnum("OB_SYNC_MODE", mode, VALID_SYNC_MODES);
  }
  const conflictStrategy = env.OB_SYNC_CONFLICT_STRATEGY;
  if (conflictStrategy !== undefined) {
    validateEnum("OB_SYNC_CONFLICT_STRATEGY", conflictStrategy, VALID_SYNC_CONFLICT_STRATEGIES);
  }
  const configs = env.OB_SYNC_CONFIGS;
  if (configs !== undefined) {
    validateCsvSubset("OB_SYNC_CONFIGS", configs, VALID_SYNC_CONFIGS);
  }
  const excludedFolders = env.OB_SYNC_EXCLUDED_FOLDERS;
  const deviceName = env.OB_SYNC_DEVICE_NAME;

  // Build the result object so `JSON.stringify` and equality checks see only
  // the fields that were actually present in `env`.
  const out: {
    fileTypes?: string;
    excludedFolders?: string;
    mode?: string;
    conflictStrategy?: string;
    deviceName?: string;
    configs?: string;
  } = {};
  if (fileTypes !== undefined) out.fileTypes = fileTypes;
  if (excludedFolders !== undefined) out.excludedFolders = excludedFolders;
  if (mode !== undefined) out.mode = mode;
  if (conflictStrategy !== undefined) out.conflictStrategy = conflictStrategy;
  if (deviceName !== undefined) out.deviceName = deviceName;
  if (configs !== undefined) out.configs = configs;
  return out;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const tokenRaw = env.OBSIDIAN_AUTH_TOKEN;
  // OBSIDIAN_AUTH_TOKEN is OPTIONAL at the env layer. A pre-existing
  // `auth_token` file (mounted volume) is an acceptable substitute per
  // the architecture spec — `ensureAuthToken` enforces that "either env
  // or file" requirement at startup.
  const token =
    typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : undefined;

  const vaultsRaw = env.VAULTS_JSON;
  if (typeof vaultsRaw !== "string" || vaultsRaw.trim() === "") {
    throw new ConfigError("VAULTS_JSON is required and must be non-empty");
  }
  const vaults = parseVaults(vaultsRaw);

  const dataDir = env.DATA_DIR ?? "/data";
  const httpPort = env.HTTP_PORT !== undefined ? parsePort(env.HTTP_PORT) : 3000;
  const httpHost = env.HTTP_HOST ?? "0.0.0.0";

  const embeddingProvider: EmbeddingProvider =
    env.EMBEDDING_PROVIDER !== undefined ? parseProvider(env.EMBEDDING_PROVIDER) : "transformers";

  const embeddingModel =
    env.EMBEDDING_MODEL ??
    (embeddingProvider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_TRANSFORMERS_MODEL);

  let openaiApiKey: string | undefined;
  let openaiBaseUrl: string | undefined;
  const openaiKeyRaw = env.OPENAI_API_KEY;
  if (openaiKeyRaw !== undefined) {
    const trimmed = openaiKeyRaw.trim();
    if (trimmed !== "") openaiApiKey = trimmed;
  }
  const openaiBaseRaw = env.OPENAI_BASE_URL;
  if (openaiBaseRaw !== undefined) {
    const trimmed = openaiBaseRaw.trim();
    if (trimmed !== "") openaiBaseUrl = trimmed;
  }

  if (embeddingProvider === "openai" && openaiApiKey === undefined) {
    throw new ConfigError("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
  }

  const logLevel: LogLevel = env.LOG_LEVEL !== undefined ? parseLevel(env.LOG_LEVEL) : "info";

  const syncConfigEnv = loadSyncConfigEnv(env);

  const cfg: Config = {
    // Trimmed token, or `undefined` when unset/whitespace-only —
    // `ensureAuthToken` falls back to the on-disk file in that case.
    obsidianAuthToken: token,
    vaults,
    dataDir,
    httpPort,
    httpHost,
    embeddingProvider,
    embeddingModel,
    ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
    ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
    logLevel,
    syncConfigEnv,
  };
  return cfg;
}
