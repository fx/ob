/**
 * Tests for `src/obsidian/bootstrap.ts`.
 *
 * Every file-system operation here runs against `Bun.tmpdirSync()`-style
 * directories — never the real `~/.config`. That's a hard rule from the
 * change doc.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthMissingError,
  type BootstrapFs,
  ensureAuthToken,
  resolveAuthTokenPath,
} from "../../src/obsidian/bootstrap.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "ob-bootstrap-"));
}

describe("resolveAuthTokenPath", () => {
  test("xdgConfigHome wins when set", () => {
    expect(resolveAuthTokenPath({ xdgConfigHome: "/x", homeDir: "/h" })).toBe(
      "/x/obsidian-headless/auth_token",
    );
  });
  test("falls back to homeDir/.config when xdg unset", () => {
    expect(resolveAuthTokenPath({ homeDir: "/h" })).toBe("/h/.config/obsidian-headless/auth_token");
  });
  test("treats empty-string xdgConfigHome as unset and falls through to homeDir", () => {
    expect(resolveAuthTokenPath({ xdgConfigHome: "", homeDir: "/h" })).toBe(
      "/h/.config/obsidian-headless/auth_token",
    );
  });
  test("treats whitespace-only xdgConfigHome as unset", () => {
    expect(resolveAuthTokenPath({ xdgConfigHome: "  \t", homeDir: "/h" })).toBe(
      "/h/.config/obsidian-headless/auth_token",
    );
  });
  test("trims surrounding whitespace from xdgConfigHome", () => {
    expect(resolveAuthTokenPath({ xdgConfigHome: "  /x  " })).toBe(
      "/x/obsidian-headless/auth_token",
    );
  });
  test("throws AuthMissingError when both xdgConfigHome and homeDir are empty", () => {
    expect(() => resolveAuthTokenPath({ xdgConfigHome: "", homeDir: "" })).toThrow(
      /XDG_CONFIG_HOME nor HOME/,
    );
  });
  test("throws AuthMissingError when both are undefined", () => {
    expect(() => resolveAuthTokenPath({})).toThrow(/XDG_CONFIG_HOME nor HOME/);
  });
});

describe("ensureAuthToken", () => {
  test("writes token, parent 0700, file 0600 when env present and config dir empty", async () => {
    const xdg = makeTmp();
    const result = await ensureAuthToken({
      authToken: "abc",
      xdgConfigHome: xdg,
      homeDir: "/dev/null",
    });
    expect(result.action).toBe("wrote");
    const tokenPath = join(xdg, "obsidian-headless", "auth_token");
    expect(result.path).toBe(tokenPath);
    expect(readFileSync(tokenPath, "utf8")).toBe("abc");
    const fileStat = statSync(tokenPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const parentStat = statSync(join(xdg, "obsidian-headless"));
    expect(parentStat.mode & 0o777).toBe(0o700);
  });

  test("idempotent — second call with matching env is no-op", async () => {
    const xdg = makeTmp();
    const tokenPath = join(xdg, "obsidian-headless", "auth_token");
    mkdirSync(join(xdg, "obsidian-headless"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "abc", { mode: 0o600 });
    const before = statSync(tokenPath).mtimeMs;
    // Bun's mtime resolution is fine but we round-trip through the API to make sure no write happened.
    const result = await ensureAuthToken({
      authToken: "abc",
      xdgConfigHome: xdg,
      homeDir: "/dev/null",
    });
    expect(result.action).toBe("unchanged");
    const after = statSync(tokenPath).mtimeMs;
    expect(after).toBe(before);
  });

  test("re-hardens looser modes on the unchanged path (file 0644 → 0600)", async () => {
    const xdg = makeTmp();
    const tokenPath = join(xdg, "obsidian-headless", "auth_token");
    mkdirSync(join(xdg, "obsidian-headless"), { recursive: true, mode: 0o755 });
    writeFileSync(tokenPath, "abc", { mode: 0o644 });
    chmodSync(tokenPath, 0o644); // belt-and-suspenders: writeFile mode is best-effort.
    const result = await ensureAuthToken({
      authToken: "abc",
      xdgConfigHome: xdg,
      homeDir: "/dev/null",
    });
    expect(result.action).toBe("unchanged");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(xdg, "obsidian-headless")).mode & 0o777).toBe(0o700);
  });

  test("re-hardens looser modes on the env-unset / file-present (mounted volume) path", async () => {
    const xdg = makeTmp();
    const tokenPath = join(xdg, "obsidian-headless", "auth_token");
    mkdirSync(join(xdg, "obsidian-headless"), { recursive: true, mode: 0o755 });
    writeFileSync(tokenPath, "mounted", { mode: 0o644 });
    chmodSync(tokenPath, 0o644);
    await ensureAuthToken({ authToken: undefined, xdgConfigHome: xdg, homeDir: "/dev/null" });
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(xdg, "obsidian-headless")).mode & 0o777).toBe(0o700);
  });

  test("overwrites file when env value differs", async () => {
    const xdg = makeTmp();
    const tokenPath = join(xdg, "obsidian-headless", "auth_token");
    mkdirSync(join(xdg, "obsidian-headless"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "old", { mode: 0o600 });
    const result = await ensureAuthToken({
      authToken: "new",
      xdgConfigHome: xdg,
      homeDir: "/dev/null",
    });
    expect(result.action).toBe("wrote");
    expect(readFileSync(tokenPath, "utf8")).toBe("new");
  });

  test("throws AuthMissingError when env unset and file missing", async () => {
    const xdg = makeTmp();
    let err: unknown;
    try {
      await ensureAuthToken({ authToken: undefined, xdgConfigHome: xdg, homeDir: "/dev/null" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthMissingError);
    expect((err as AuthMissingError).exitCode).toBe(78);
    expect((err as AuthMissingError).message).toContain("OBSIDIAN_AUTH_TOKEN is required");
  });

  test("throws AuthMissingError when env is empty string and file missing", async () => {
    const xdg = makeTmp();
    let err: unknown;
    try {
      await ensureAuthToken({ authToken: "", xdgConfigHome: xdg, homeDir: "/dev/null" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthMissingError);
  });

  test("env unset but mounted file exists — leaves file untouched", async () => {
    const xdg = makeTmp();
    const tokenPath = join(xdg, "obsidian-headless", "auth_token");
    mkdirSync(join(xdg, "obsidian-headless"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "mounted", { mode: 0o600 });
    const result = await ensureAuthToken({
      authToken: undefined,
      xdgConfigHome: xdg,
      homeDir: "/dev/null",
    });
    expect(result.action).toBe("unchanged");
    expect(readFileSync(tokenPath, "utf8")).toBe("mounted");
  });

  test("uses homeDir when xdgConfigHome is unset", async () => {
    const home = makeTmp();
    const result = await ensureAuthToken({ authToken: "abc", homeDir: home });
    const expected = join(home, ".config", "obsidian-headless", "auth_token");
    expect(result.path).toBe(expected);
    expect(readFileSync(expected, "utf8")).toBe("abc");
  });

  test("propagates non-ENOENT errors from readFile", async () => {
    const xdg = makeTmp();
    const fakeFs: BootstrapFs = {
      mkdir: async () => undefined,
      readFile: async () => {
        const e = Object.assign(new Error("eacces"), { code: "EACCES" });
        throw e;
      },
      writeFile: async () => undefined,
      chmod: async () => undefined,
    };
    let err: unknown;
    try {
      await ensureAuthToken({ authToken: "abc", xdgConfigHome: xdg, homeDir: "/dev/null" }, fakeFs);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("eacces");
  });

  test("propagates non-Error throws from readFile", async () => {
    const xdg = makeTmp();
    const fakeFs: BootstrapFs = {
      mkdir: async () => undefined,
      readFile: async () => {
        // eslint-disable-next-line no-throw-literal -- exercising non-Error branch
        throw "raw fs failure";
      },
      writeFile: async () => undefined,
      chmod: async () => undefined,
    };
    let err: unknown;
    try {
      await ensureAuthToken({ authToken: "abc", xdgConfigHome: xdg, homeDir: "/dev/null" }, fakeFs);
    } catch (e) {
      err = e;
    }
    expect(err).toBe("raw fs failure");
  });
});
