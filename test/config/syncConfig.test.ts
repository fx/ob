/**
 * Tests for `loadSyncConfigEnv` — the validator/normaliser for the
 * `OB_SYNC_*` env-var family that drives `ob sync-config`.
 *
 * Three states per var: unset → `undefined`; empty string → `""` (the
 * upstream "empty to clear" sentinel); non-empty string → verbatim value.
 * Invalid enum values must throw `ConfigError` (exit 78), naming the
 * offending var and the acceptable values.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError, loadSyncConfigEnv } from "../../src/config/index.ts";

describe("loadSyncConfigEnv — defaults", () => {
  test("returns an object with no fields when no OB_SYNC_* vars are set", () => {
    const out = loadSyncConfigEnv({});
    expect(out).toEqual({});
    expect(out.fileTypes).toBeUndefined();
    expect(out.excludedFolders).toBeUndefined();
    expect(out.mode).toBeUndefined();
    expect(out.conflictStrategy).toBeUndefined();
    expect(out.deviceName).toBeUndefined();
    expect(out.configs).toBeUndefined();
  });

  test("ignores unrelated env vars", () => {
    const out = loadSyncConfigEnv({ HOME: "/root", PATH: "/usr/bin" });
    expect(out).toEqual({});
  });
});

describe("loadSyncConfigEnv — OB_SYNC_FILE_TYPES", () => {
  test("accepts a single valid token", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_FILE_TYPES: "image" });
    expect(out.fileTypes).toBe("image");
  });

  test("accepts the full valid set", () => {
    const out = loadSyncConfigEnv({
      OB_SYNC_FILE_TYPES: "image,audio,pdf,video,unsupported",
    });
    expect(out.fileTypes).toBe("image,audio,pdf,video,unsupported");
  });

  test("accepts whitespace around tokens and normalizes them out", () => {
    // Per the validator contract: whitespace is permitted in the source env
    // var but the value forwarded downstream must be the trimmed/normalized
    // CSV. Otherwise " image , audio " would survive into the `ob sync-config
    // --file-types` argv and turn a config typo into a runtime failure.
    const out = loadSyncConfigEnv({ OB_SYNC_FILE_TYPES: " image , audio " });
    expect(out.fileTypes).toBe("image,audio");
  });

  test("accepts empty string ('empty to clear')", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_FILE_TYPES: "" });
    expect(out.fileTypes).toBe("");
  });

  test("rejects an unknown token", () => {
    let err: unknown;
    try {
      loadSyncConfigEnv({ OB_SYNC_FILE_TYPES: "image,markdown" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain("OB_SYNC_FILE_TYPES");
    expect(msg).toContain("markdown");
    expect(msg).toContain("image");
  });

  test("rejects a stray empty token from a doubled comma", () => {
    expect(() => loadSyncConfigEnv({ OB_SYNC_FILE_TYPES: "image,,audio" })).toThrow(
      /OB_SYNC_FILE_TYPES/,
    );
  });
});

describe("loadSyncConfigEnv — OB_SYNC_EXCLUDED_FOLDERS", () => {
  test("passes the value verbatim with no validation", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_EXCLUDED_FOLDERS: "trash,/abs/path" });
    expect(out.excludedFolders).toBe("trash,/abs/path");
  });

  test("accepts empty string ('empty to clear')", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_EXCLUDED_FOLDERS: "" });
    expect(out.excludedFolders).toBe("");
  });
});

describe("loadSyncConfigEnv — OB_SYNC_MODE", () => {
  test.each(["bidirectional", "pull-only", "mirror-remote"])("accepts %s", (mode) => {
    const out = loadSyncConfigEnv({ OB_SYNC_MODE: mode });
    expect(out.mode).toBe(mode);
  });

  test("accepts empty string", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_MODE: "" });
    expect(out.mode).toBe("");
  });

  test("rejects bad value naming the var and listing accepted values", () => {
    let err: unknown;
    try {
      loadSyncConfigEnv({ OB_SYNC_MODE: "push-only" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain("OB_SYNC_MODE");
    expect(msg).toContain("bidirectional");
    expect(msg).toContain("pull-only");
    expect(msg).toContain("mirror-remote");
  });
});

describe("loadSyncConfigEnv — OB_SYNC_CONFLICT_STRATEGY", () => {
  test.each(["merge", "conflict"])("accepts %s", (s) => {
    const out = loadSyncConfigEnv({ OB_SYNC_CONFLICT_STRATEGY: s });
    expect(out.conflictStrategy).toBe(s);
  });

  test("accepts empty string", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_CONFLICT_STRATEGY: "" });
    expect(out.conflictStrategy).toBe("");
  });

  test("rejects bad value", () => {
    let err: unknown;
    try {
      loadSyncConfigEnv({ OB_SYNC_CONFLICT_STRATEGY: "yolo" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("OB_SYNC_CONFLICT_STRATEGY");
    expect((err as ConfigError).message).toContain("merge");
  });
});

describe("loadSyncConfigEnv — OB_SYNC_DEVICE_NAME", () => {
  test("passes verbatim", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_DEVICE_NAME: "pod-42" });
    expect(out.deviceName).toBe("pod-42");
  });

  test("accepts empty string", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_DEVICE_NAME: "" });
    expect(out.deviceName).toBe("");
  });
});

describe("loadSyncConfigEnv — OB_SYNC_CONFIGS", () => {
  test("accepts the full valid set", () => {
    const all =
      "app,appearance,appearance-data,hotkey,core-plugin,core-plugin-data,community-plugin,community-plugin-data";
    const out = loadSyncConfigEnv({ OB_SYNC_CONFIGS: all });
    expect(out.configs).toBe(all);
  });

  test("accepts a single valid token", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_CONFIGS: "app" });
    expect(out.configs).toBe("app");
  });

  test("accepts empty string", () => {
    const out = loadSyncConfigEnv({ OB_SYNC_CONFIGS: "" });
    expect(out.configs).toBe("");
  });

  test("rejects unknown token naming the var and offending token", () => {
    let err: unknown;
    try {
      loadSyncConfigEnv({ OB_SYNC_CONFIGS: "app,plugins" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain("OB_SYNC_CONFIGS");
    expect(msg).toContain("plugins");
  });
});

describe("loadSyncConfigEnv — composition", () => {
  test("plumbs every var through when all are set", () => {
    const out = loadSyncConfigEnv({
      OB_SYNC_FILE_TYPES: "image,audio,pdf,video,unsupported",
      OB_SYNC_EXCLUDED_FOLDERS: "trash",
      OB_SYNC_MODE: "bidirectional",
      OB_SYNC_CONFLICT_STRATEGY: "merge",
      OB_SYNC_DEVICE_NAME: "pod-1",
      OB_SYNC_CONFIGS: "app",
    });
    expect(out).toEqual({
      fileTypes: "image,audio,pdf,video,unsupported",
      excludedFolders: "trash",
      mode: "bidirectional",
      conflictStrategy: "merge",
      deviceName: "pod-1",
      configs: "app",
    });
  });
});
