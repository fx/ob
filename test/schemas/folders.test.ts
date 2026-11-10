import { describe, expect, test } from "bun:test";
import { CreateFolderInput, CreateFolderResponse } from "../../src/schemas/index.ts";

describe("CreateFolderResponse", () => {
  test("needs path + mtimeMs + created", () => {
    expect(() =>
      CreateFolderResponse.parse({ path: "a", mtimeMs: 1, created: true }),
    ).not.toThrow();
    expect(() => CreateFolderResponse.parse({ path: "a", mtimeMs: 1 })).toThrow();
  });
});

describe("CreateFolderInput", () => {
  test("requires vault + non-empty path", () => {
    expect(CreateFolderInput.parse({ vault: "v", path: "a" }).path).toBe("a");
    expect(() => CreateFolderInput.parse({ vault: "v", path: "" })).toThrow();
  });
});
