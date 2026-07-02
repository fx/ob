import { describe, expect, test } from "bun:test";
import {
  detectContentType,
  isMarkdownPath,
  isPdfPath,
  isTextPath,
} from "../../src/vault/contentType.ts";

describe("detectContentType", () => {
  test("maps the spec'd extensions", () => {
    expect(detectContentType("notes/x.md")).toBe("text/markdown; charset=utf-8");
    expect(detectContentType("a.markdown")).toBe("text/markdown; charset=utf-8");
    expect(detectContentType("attachments/y.png")).toBe("image/png");
    expect(detectContentType("y.JPG")).toBe("image/jpeg");
    expect(detectContentType("x.jpeg")).toBe("image/jpeg");
    expect(detectContentType("x.gif")).toBe("image/gif");
    expect(detectContentType("x.webp")).toBe("image/webp");
    expect(detectContentType("x.svg")).toBe("image/svg+xml");
    expect(detectContentType("x.pdf")).toBe("application/pdf");
    expect(detectContentType("x.json")).toBe("application/json");
    expect(detectContentType("x.html")).toBe("text/html; charset=utf-8");
    expect(detectContentType("x.csv")).toBe("text/csv; charset=utf-8");
    expect(detectContentType("x.toml")).toBe("application/toml");
    expect(detectContentType("x.xml")).toBe("application/xml");
    expect(detectContentType("x.yaml")).toBe("application/yaml");
    expect(detectContentType("x.yml")).toBe("application/yaml");
    expect(detectContentType("x.txt")).toBe("text/plain; charset=utf-8");
  });

  test("returns octet-stream for unknown extensions", () => {
    expect(detectContentType("a.xyz")).toBe("application/octet-stream");
  });

  test("returns octet-stream when there is no extension", () => {
    expect(detectContentType("README")).toBe("application/octet-stream");
  });

  test("returns octet-stream when the dot is in a parent dir, not the basename", () => {
    expect(detectContentType("foo.bar/baz")).toBe("application/octet-stream");
    expect(detectContentType("foo.bar\\baz")).toBe("application/octet-stream");
  });
});

describe("isTextPath", () => {
  test("allows the spec's text extensions", () => {
    for (const ext of [
      "md",
      "markdown",
      "txt",
      "json",
      "yaml",
      "yml",
      "csv",
      "toml",
      "html",
      "xml",
      "svg", // image/svg+xml — `+xml` structured-suffix variant
      "geojson", // application/geo+json — `+json` structured-suffix variant
    ]) {
      expect(isTextPath(`a.${ext}`)).toBe(true);
    }
  });

  test("rejects binary extensions", () => {
    for (const ext of ["png", "jpg", "pdf", "gif", "webp", "xyz"]) {
      expect(isTextPath(`a.${ext}`)).toBe(false);
    }
  });

  test("rejects no-extension paths", () => {
    expect(isTextPath("README")).toBe(false);
  });
});

describe("isMarkdownPath", () => {
  test("only true for .md / .markdown", () => {
    expect(isMarkdownPath("a.md")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(true);
    expect(isMarkdownPath("A.MD")).toBe(true);
    expect(isMarkdownPath("a.txt")).toBe(false);
    expect(isMarkdownPath("a.json")).toBe(false);
  });
});

describe("isPdfPath", () => {
  test("only true for .pdf (case-insensitive)", () => {
    expect(isPdfPath("paper.pdf")).toBe(true);
    expect(isPdfPath("papers/attention.PDF")).toBe(true);
    expect(isPdfPath("a.md")).toBe(false);
    expect(isPdfPath("a.png")).toBe(false);
    expect(isPdfPath("noext")).toBe(false);
  });
});
