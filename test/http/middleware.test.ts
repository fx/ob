import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { logMiddleware } from "../../src/http/middleware/log.ts";
import { getRequestId, requestIdMiddleware } from "../../src/http/middleware/requestId.ts";
import type { Logger } from "../../src/log.ts";

interface LogCall {
  msg: string;
  fields?: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push = (msg: string, fields?: Record<string, unknown>): void => {
    calls.push({ msg, fields });
  };
  return {
    calls,
    logger: {
      trace: push,
      debug: push,
      info: push,
      warn: push,
      error: push,
    },
  };
}

describe("requestIdMiddleware", () => {
  test("generates a UUID when no incoming header", async () => {
    const app = new Hono();
    app.use("*", requestIdMiddleware());
    let captured: string | undefined;
    app.get("/p", (c) => {
      captured = getRequestId(c);
      return c.text("ok");
    });
    const res = await app.request("/p");
    expect(captured?.length).toBeGreaterThan(0);
    expect(res.headers.get("x-request-id")).toBe(captured ?? "");
  });

  test("honours an incoming x-request-id", async () => {
    const app = new Hono();
    app.use("*", requestIdMiddleware());
    let captured: string | undefined;
    app.get("/p", (c) => {
      captured = getRequestId(c);
      return c.text("ok");
    });
    const res = await app.request("/p", { headers: { "x-request-id": "fixed" } });
    expect(captured).toBe("fixed");
    expect(res.headers.get("x-request-id")).toBe("fixed");
  });

  test("uses a custom generator + custom header name", async () => {
    const app = new Hono();
    app.use("*", requestIdMiddleware({ generate: () => "static-id", header: "x-trace-id" }));
    app.get("/p", (c) => c.text(getRequestId(c)));
    const res = await app.request("/p");
    expect(res.headers.get("x-trace-id")).toBe("static-id");
    expect(await res.text()).toBe("static-id");
  });

  test("getRequestId returns '' when stored value is non-string", async () => {
    // A bare context where requestId was never set falls back to "".
    // We exercise the empty-string branch by attaching the middleware but
    // not setting the value.
    const app = new Hono();
    app.get("/p", (c) => {
      // Manually clear the value so the type-check branch fires.
      // biome-ignore lint/suspicious/noExplicitAny: deliberate context poke for the empty branch.
      (c as any).set("requestId", 5);
      return c.text(getRequestId(c));
    });
    const res = await app.request("/p");
    expect(await res.text()).toBe("");
  });

  test("treats an empty incoming header as missing and generates a fresh id", async () => {
    const app = new Hono();
    app.use("*", requestIdMiddleware({ generate: () => "fallback" }));
    app.get("/p", (c) => c.text(getRequestId(c)));
    const res = await app.request("/p", { headers: { "x-request-id": "" } });
    expect(res.headers.get("x-request-id")).toBe("fallback");
  });
});

describe("logMiddleware", () => {
  test("logs method, path, status, durationMs, requestId", async () => {
    const cap = captureLogger();
    const app = new Hono();
    let nowVal = 1000;
    app.use("*", requestIdMiddleware({ generate: () => "rid-1" }));
    app.use(
      "*",
      logMiddleware({
        logger: cap.logger,
        now: (): number => {
          const v = nowVal;
          nowVal += 5;
          return v;
        },
      }),
    );
    app.get("/p", (c) => c.text("ok"));
    await app.request("/p");
    expect(cap.calls.length).toBe(1);
    expect(cap.calls[0]?.fields).toMatchObject({
      method: "GET",
      path: "/p",
      status: 200,
      durationMs: 5,
      requestId: "rid-1",
    });
  });

  test("logs even when the route throws (status reflected)", async () => {
    const cap = captureLogger();
    const app = new Hono();
    app.use("*", requestIdMiddleware({ generate: () => "rid-2" }));
    app.use("*", logMiddleware({ logger: cap.logger }));
    app.onError((_e, c) => c.json({ ok: false }, 500));
    app.get("/p", () => {
      throw new Error("boom");
    });
    await app.request("/p");
    // log records the post-onError status
    expect(cap.calls[0]?.fields?.status).toBe(500);
  });

  test("uses Date.now when no `now` is injected", async () => {
    const cap = captureLogger();
    const app = new Hono();
    app.use("*", requestIdMiddleware());
    app.use("*", logMiddleware({ logger: cap.logger }));
    app.get("/p", (c) => c.text("ok"));
    await app.request("/p");
    expect(cap.calls[0]?.fields?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
