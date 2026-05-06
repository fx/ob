import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config/index.ts";

const TOKEN = "tk";

describe("loadConfig — required vars", () => {
  test("OBSIDIAN_AUTH_TOKEN missing yields obsidianAuthToken=undefined (file fallback handled later)", () => {
    const cfg = loadConfig({ VAULTS_JSON: '[{"name":"v"}]' });
    expect(cfg.obsidianAuthToken).toBeUndefined();
  });

  test("empty OBSIDIAN_AUTH_TOKEN is normalised to undefined", () => {
    const cfg = loadConfig({ OBSIDIAN_AUTH_TOKEN: "", VAULTS_JSON: '[{"name":"v"}]' });
    expect(cfg.obsidianAuthToken).toBeUndefined();
  });

  test("whitespace-only OBSIDIAN_AUTH_TOKEN is normalised to undefined", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: "   \t\n",
      VAULTS_JSON: '[{"name":"v"}]',
    });
    expect(cfg.obsidianAuthToken).toBeUndefined();
  });

  test("trims surrounding whitespace from OBSIDIAN_AUTH_TOKEN", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: "  realtoken\n",
      VAULTS_JSON: '[{"name":"v"}]',
    });
    expect(cfg.obsidianAuthToken).toBe("realtoken");
  });

  // Note: ConfigError is still imported because it's used in other test groups below.
  test("VAULTS_JSON validation still uses ConfigError", () => {
    let err: unknown;
    try {
      loadConfig({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
  });

  test("throws when VAULTS_JSON is missing", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN })).toThrow(/VAULTS_JSON/);
  });

  test("throws when VAULTS_JSON is empty string", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: "" })).toThrow(
      /VAULTS_JSON/,
    );
  });

  test("throws when VAULTS_JSON is whitespace-only", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: "   " })).toThrow(
      /VAULTS_JSON/,
    );
  });
});

describe("loadConfig — VAULTS_JSON parsing", () => {
  test("rejects invalid JSON", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: "not json" })).toThrow(
      /not valid JSON/,
    );
  });

  test("rejects non-array root", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '{"name":"v"}' })).toThrow(
      /non-empty JSON array/,
    );
  });

  test("rejects empty array", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: "[]" })).toThrow(
      /non-empty JSON array/,
    );
  });

  test("rejects non-object entry", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '["string"]' })).toThrow(
      /VAULTS_JSON\[0\] must be an object/,
    );
  });

  test("rejects array entry (entries must be plain objects)", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: "[[]]" })).toThrow(
      /must be an object/,
    );
  });

  test("rejects entry without name", () => {
    expect(() => loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: "[{}]" })).toThrow(
      /name must be a non-empty string/,
    );
  });

  test("rejects empty name", () => {
    expect(() =>
      loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"   "}]' }),
    ).toThrow(/name must be a non-empty string/);
  });

  test("rejects non-string slug", () => {
    expect(() =>
      loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"v","slug":42}]' }),
    ).toThrow(/slug must be a non-empty string/);
  });

  test("rejects empty slug string", () => {
    expect(() =>
      loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"v","slug":"  "}]' }),
    ).toThrow(/slug must be a non-empty string/);
  });

  test("rejects name that slugifies to empty string", () => {
    expect(() =>
      loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"!!!"}]' }),
    ).toThrow(/empty slug/);
  });

  test("rejects non-string e2eePassword", () => {
    expect(() =>
      loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"v","e2eePassword":1}]' }),
    ).toThrow(/e2eePassword must be a string/);
  });

  test("normalizes name to slug (kebab-case)", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"My Vault!"}]',
    });
    expect(cfg.vaults).toEqual([{ name: "My Vault!", slug: "my-vault" }]);
  });

  test("uses provided slug verbatim (after slugify normalization)", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"X","slug":"Custom Slug"}]',
    });
    expect(cfg.vaults[0]?.slug).toBe("custom-slug");
  });

  test("preserves e2eePassword when provided", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v","e2eePassword":"secret"}]',
    });
    expect(cfg.vaults[0]?.e2eePassword).toBe("secret");
  });

  test("rejects duplicate slugs naming both source vaults", () => {
    try {
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"V"},{"name":"v"}]',
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.message).toContain('"V"');
      expect(err.message).toContain('"v"');
      expect(err.message).toContain('"v"');
    }
  });
});

describe("loadConfig — port / host / log level / provider", () => {
  test("defaults port=3000, host=0.0.0.0, level=info, provider=transformers", () => {
    const cfg = loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"v"}]' });
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.httpHost).toBe("0.0.0.0");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.embeddingProvider).toBe("transformers");
    expect(cfg.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    expect(cfg.dataDir).toBe("/data");
    expect(cfg.openaiApiKey).toBeUndefined();
    expect(cfg.openaiBaseUrl).toBeUndefined();
  });

  test("rejects non-numeric HTTP_PORT", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        HTTP_PORT: "abc",
      }),
    ).toThrow(/HTTP_PORT must be a non-negative integer/);
  });

  test("rejects negative HTTP_PORT (negative sign fails the regex)", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        HTTP_PORT: "-1",
      }),
    ).toThrow(/non-negative integer/);
  });

  test("rejects out-of-range HTTP_PORT", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        HTTP_PORT: "70000",
      }),
    ).toThrow(/between 0 and 65535/);
  });

  test("accepts HTTP_PORT 0 (ephemeral)", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      HTTP_PORT: "0",
    });
    expect(cfg.httpPort).toBe(0);
  });

  test("accepts low boundary HTTP_PORT 1", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      HTTP_PORT: "1",
    });
    expect(cfg.httpPort).toBe(1);
  });

  test("accepts custom HTTP_HOST and DATA_DIR", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      HTTP_HOST: "127.0.0.1",
      DATA_DIR: "/tmp/data",
    });
    expect(cfg.httpHost).toBe("127.0.0.1");
    expect(cfg.dataDir).toBe("/tmp/data");
  });

  test("accepts every valid LOG_LEVEL", () => {
    for (const lvl of ["trace", "debug", "info", "warn", "error"] as const) {
      const cfg = loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        LOG_LEVEL: lvl,
      });
      expect(cfg.logLevel).toBe(lvl);
    }
  });

  test("rejects bad LOG_LEVEL", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        LOG_LEVEL: "loud",
      }),
    ).toThrow(/LOG_LEVEL/);
  });

  test("rejects bad EMBEDDING_PROVIDER", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        EMBEDDING_PROVIDER: "cohere",
      }),
    ).toThrow(/EMBEDDING_PROVIDER/);
  });

  test("openai provider requires OPENAI_API_KEY", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        EMBEDDING_PROVIDER: "openai",
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  test("openai provider with empty OPENAI_API_KEY also rejected", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        EMBEDDING_PROVIDER: "openai",
        OPENAI_API_KEY: "",
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  test("openai provider picks default model and reads optional base URL", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-x",
      OPENAI_BASE_URL: "https://example.test/v1",
    });
    expect(cfg.embeddingProvider).toBe("openai");
    expect(cfg.embeddingModel).toBe("text-embedding-3-small");
    expect(cfg.openaiApiKey).toBe("sk-x");
    expect(cfg.openaiBaseUrl).toBe("https://example.test/v1");
  });

  test("explicit EMBEDDING_MODEL overrides default", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      EMBEDDING_MODEL: "my-model",
    });
    expect(cfg.embeddingModel).toBe("my-model");
  });

  test("empty OPENAI_BASE_URL is treated as unset", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      OPENAI_BASE_URL: "",
    });
    expect(cfg.openaiBaseUrl).toBeUndefined();
  });

  test("whitespace-only OPENAI_API_KEY rejected for provider=openai", () => {
    expect(() =>
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        EMBEDDING_PROVIDER: "openai",
        OPENAI_API_KEY: "   ",
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  test("whitespace-only OPENAI_BASE_URL is treated as unset", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      OPENAI_BASE_URL: "   \t",
    });
    expect(cfg.openaiBaseUrl).toBeUndefined();
  });

  test("OPENAI_API_KEY and OPENAI_BASE_URL are trimmed when set", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "  sk-trimmed  ",
      OPENAI_BASE_URL: "  https://api.example/v1  ",
    });
    expect(cfg.openaiApiKey).toBe("sk-trimmed");
    expect(cfg.openaiBaseUrl).toBe("https://api.example/v1");
  });
});

describe("loadConfig — OB_SYNC_* plumbing", () => {
  test("syncConfigEnv defaults to an empty object when no OB_SYNC_* vars are set", () => {
    const cfg = loadConfig({ OBSIDIAN_AUTH_TOKEN: TOKEN, VAULTS_JSON: '[{"name":"v"}]' });
    expect(cfg.syncConfigEnv).toEqual({});
  });

  test("syncConfigEnv carries through validated OB_SYNC_* values", () => {
    const cfg = loadConfig({
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: '[{"name":"v"}]',
      OB_SYNC_FILE_TYPES: "image,audio,pdf,video,unsupported",
      OB_SYNC_MODE: "bidirectional",
    });
    expect(cfg.syncConfigEnv.fileTypes).toBe("image,audio,pdf,video,unsupported");
    expect(cfg.syncConfigEnv.mode).toBe("bidirectional");
    expect(cfg.syncConfigEnv.deviceName).toBeUndefined();
  });

  test("loadConfig surfaces OB_SYNC_* validation as ConfigError (exit 78)", () => {
    let err: unknown;
    try {
      loadConfig({
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: '[{"name":"v"}]',
        OB_SYNC_MODE: "push-only",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(78);
    expect((err as ConfigError).message).toContain("OB_SYNC_MODE");
  });
});
