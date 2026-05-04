import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WatcherEvent, startWatcher } from "../../src/indexer/watcher.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "ob-watcher-test-"));
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
});

function collect(): { events: WatcherEvent[]; on: (e: WatcherEvent) => void } {
  const events: WatcherEvent[] = [];
  return {
    events,
    on: (e) => {
      events.push(e);
    },
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000, pollMs = 25): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await waitMs(pollMs);
  }
}

describe("startWatcher (real fs)", () => {
  test("ignores hidden directories like .obsidian/", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    await w.ready();
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(join(root, ".obsidian", "workspace.json"), "{}");
    await waitMs(400);
    expect(sink.events).toEqual([]);
  });

  test("ignores non-markdown files", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    await w.ready();
    writeFileSync(join(root, "x.txt"), "not md");
    await waitMs(400);
    expect(sink.events).toEqual([]);
  });

  test("emits one upsert event for a new markdown file", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    await w.ready();
    writeFileSync(join(root, "note.md"), "# H");
    await waitUntil(() => sink.events.length > 0);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.kind).toBe("upsert");
    expect(sink.events[0]?.relPath).toBe("note.md");
  });

  test("debounce coalesces 5 rapid writes into one event", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 75 });
    cleanup.push(async () => w.stop());
    await w.ready();
    const target = join(root, "x.md");
    for (let i = 0; i < 5; i++) {
      writeFileSync(target, `content ${i}`);
      await waitMs(10);
    }
    await waitUntil(() => sink.events.length > 0, 1000);
    await waitMs(150);
    expect(sink.events.length).toBe(1);
    expect(sink.events[0]?.kind).toBe("upsert");
  });

  test("unlink emits a remove event", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    await w.ready();
    const f = join(root, "y.md");
    writeFileSync(f, "x");
    await waitUntil(() => sink.events.length > 0, 2000);
    sink.events.length = 0;
    unlinkSync(f);
    await waitUntil(() => sink.events.length > 0, 2000);
    expect(sink.events[0]?.kind).toBe("remove");
  });

  test("emits ready promise that resolves once chokidar settles", async () => {
    const root = tmpRoot();
    const w = startWatcher(root, () => undefined, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    const a = w.ready();
    const b = w.ready();
    expect(a).toBe(b);
    await a;
  });

  test("nested-directory writes are observed", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    await w.ready();
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "z.md"), "x");
    await waitUntil(() => sink.events.length > 0);
    expect(sink.events[0]?.relPath).toBe("sub/z.md");
  });

  test("stop flushes pending events before tearing down", async () => {
    const root = tmpRoot();
    const sink = collect();
    // Use a fake clock so the debounce timer never fires by itself; force
    // the flush to happen via stop().
    const clock: { fired: number; pending: Array<() => void> } = { fired: 0, pending: [] };
    const w = startWatcher(root, sink.on, {
      debounceMs: 60_000,
      setTimer: (cb) => {
        clock.pending.push(cb);
        return clock.pending.length - 1;
      },
      clearTimer: () => undefined,
    });
    cleanup.push(async () => undefined);
    await w.ready();
    writeFileSync(join(root, "fl.md"), "x");
    await waitMs(80);
    // No event yet — the fake debounce timer hasn't fired.
    expect(sink.events).toEqual([]);
    await w.stop();
    // After stop, the queued event was flushed synchronously through
    // onEvent. Our `setTimer` returned IDs, not real timers, so the event
    // is the queued payload — kind: upsert.
    expect(sink.events.length).toBe(1);
    expect(sink.events[0]?.kind).toBe("upsert");
    expect(sink.events[0]?.relPath).toBe("fl.md");
  });

  test("clean shutdown when no pending events", async () => {
    const root = tmpRoot();
    const sink = collect();
    const w = startWatcher(root, sink.on, { debounceMs: 50 });
    await w.ready();
    await w.stop();
    expect(sink.events).toEqual([]);
  });

  test("chokidar `error` events surface via lastError() + logger + onError (LDn0)", async () => {
    const root = tmpRoot();
    const sink = collect();
    let captured: Error | null = null;
    const logEntries: string[] = [];
    const logger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string): void => {
        logEntries.push(msg);
      },
      error: () => undefined,
    };
    let injectedFsw: { emit: (e: string, a: unknown) => void } | undefined;
    // Inject a fake watch impl so we can synthesise an `error` event
    // without needing a real fs failure mode.
    const fakeWatch = (() => {
      const handlers = new Map<string, ((arg: unknown) => void)[]>();
      const on = (evt: string, cb: (arg: unknown) => void): unknown => {
        const list = handlers.get(evt) ?? [];
        list.push(cb);
        handlers.set(evt, list);
        return injectedFsw;
      };
      const fsw = {
        on,
        once: on,
        close: async (): Promise<void> => undefined,
        emit: (evt: string, arg: unknown): void => {
          for (const h of handlers.get(evt) ?? []) h(arg);
        },
      };
      injectedFsw = fsw;
      return fsw;
    }) as unknown as typeof import("chokidar").watch;
    const w = startWatcher(root, sink.on, {
      watchImpl: fakeWatch,
      logger,
      onError: (e) => {
        captured = e;
      },
    });
    cleanup.push(async () => w.stop());
    const ENOSPC = new Error("ENOSPC: no space");
    injectedFsw?.emit("error", ENOSPC);
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toBe("ENOSPC: no space");
    expect(w.lastError()?.message).toBe("ENOSPC: no space");
    expect(logEntries).toContain("indexer: chokidar error");
  });

  test("non-Error error payload is wrapped in Error", async () => {
    const root = tmpRoot();
    let injectedFsw: { emit: (e: string, a: unknown) => void } | undefined;
    const fakeWatch = (() => {
      const handlers = new Map<string, ((arg: unknown) => void)[]>();
      const fsw = {
        on: (evt: string, cb: (arg: unknown) => void): unknown => {
          const list = handlers.get(evt) ?? [];
          list.push(cb);
          handlers.set(evt, list);
          return injectedFsw;
        },
        once: (evt: string, cb: (arg: unknown) => void): unknown => {
          const list = handlers.get(evt) ?? [];
          list.push(cb);
          handlers.set(evt, list);
          return injectedFsw;
        },
        close: async (): Promise<void> => undefined,
        emit: (evt: string, arg: unknown): void => {
          for (const h of handlers.get(evt) ?? []) h(arg);
        },
      };
      injectedFsw = fsw;
      return fsw;
    }) as unknown as typeof import("chokidar").watch;
    const w = startWatcher(root, () => undefined, { watchImpl: fakeWatch });
    cleanup.push(async () => w.stop());
    injectedFsw?.emit("error", "string error");
    expect(w.lastError()?.message).toBe("string error");
  });

  test("lastError() returns null before any error fires", async () => {
    const root = tmpRoot();
    const w = startWatcher(root, () => undefined, { debounceMs: 50 });
    cleanup.push(async () => w.stop());
    expect(w.lastError()).toBeNull();
  });
});
