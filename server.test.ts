import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";

const ARCHIVE = { id: "sec_archive", name: "🗑️ Archived" };
const WORK = { id: "sec_work", name: "Work" };

type Thread = {
  id: string;
  sectionId: string | null;
  pinnedAt: number | null;
  archivedAt: number | null;
  title: string | null;
};
const makeThreadResponse = (t: Partial<Thread> & { id: string }): Thread => ({
  sectionId: null,
  pinnedAt: null,
  archivedAt: null,
  title: null,
  ...t,
});

/**
 * Minimal stand-in for the parts of `bb` the plugin uses. It records sdk
 * calls and keeps live thread state, so `threads.get` sees earlier writes.
 */
async function load(archived: Thread[] = []) {
  const store = new Map(archived.map((t) => [t.id, { ...t }]));
  const recorded: Record<string, unknown[]> = {};
  const failNext: Record<string, boolean> = {};
  const record =
    (path: string, apply: (t: Thread, args: { threadId: string; sectionId?: string | null }) => void) =>
    async (args: { threadId: string; sectionId?: string | null }) => {
      (recorded[path] ??= []).push(args);
      if (failNext[path]) {
        failNext[path] = false;
        throw new Error(`${path} failed`);
      }
      const thread = store.get(args.threadId)!;
      apply(thread, args);
      return { ...thread };
    };
  const kv = new Map<string, unknown>();
  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {};
  let cli: { run(argv: string[]): Promise<{ exitCode: number; stdout?: string }> } | undefined;
  const bb = {
    settings: { define: () => ({ get: async () => ({ sectionName: "Archived", restoreOnUnarchive: true }) }) },
    sdk: {
      threadSections: { list: async () => [ARCHIVE, WORK], create: async () => ARCHIVE },
      threads: {
        list: async () => [...store.values()].filter((t) => t.archivedAt !== null).map((t) => ({ ...t })),
        get: async ({ threadId }: { threadId: string }) => ({ ...store.get(threadId)! }),
        update: record("threads.update", (t, a) => void (t.sectionId = a.sectionId ?? null)),
        pin: record("threads.pin", (t) => void (t.pinnedAt = 2000)),
        unpin: record("threads.unpin", (t) => void (t.pinnedAt = null)),
      },
    },
    storage: {
      kv: {
        get: async (k: string) => kv.get(k) ?? null,
        set: async (k: string, v: unknown) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
    },
    events: { on: (name: string, fn: (payload: unknown) => Promise<unknown>) => void (handlers[name] = fn) },
    background: { service: () => undefined },
    cli: { register: (registration: typeof cli) => void (cli = registration) },
    log: { info: () => undefined, warn: () => undefined },
  };
  await plugin(bb as unknown as BbPluginApi);
  return {
    store,
    failNext: (path: string) => void (failNext[path] = true),
    harness: {
      sdk: { callsTo: (path: string) => (recorded[path] ?? []).map((args) => [args]) },
      emitThreadEvent: (name: string, payload: { thread: Thread }) => handlers[name]!(payload),
      runCli: (argv: string[]) => cli!.run(argv),
    },
    /** Archive or unarchive as core would: change state, then fire the event with a snapshot. */
    async archive(thread: Thread) {
      const live = store.get(thread.id) ?? { ...thread };
      live.archivedAt = 5;
      store.set(thread.id, live);
      await handlers["thread.archived"]!({ thread: { ...live } });
    },
    async unarchive(id: string) {
      store.get(id)!.archivedAt = null;
      await handlers["thread.unarchived"]!({ thread: { ...store.get(id)! } });
    },
  };
}

const calls = (host: Awaited<ReturnType<typeof load>>, path: string) =>
  host.harness.sdk.callsTo(path).map(([args]) => args);

test("archiving a pinned thread unpins it and moves it into the archive section", async () => {
  const host = await load();
  const thread = makeThreadResponse({ id: "thr_a", sectionId: WORK.id, pinnedAt: 1000 });
  await host.archive(thread);

  assert.deepEqual(calls(host, "threads.unpin"), [{ threadId: "thr_a" }]);
  assert.deepEqual(calls(host, "threads.update"), [{ threadId: "thr_a", sectionId: ARCHIVE.id }]);
});

test("archiving an unpinned thread does not call unpin", async () => {
  const host = await load();
  const thread = makeThreadResponse({ id: "thr_b", sectionId: WORK.id, pinnedAt: null });
  await host.archive(thread);

  assert.deepEqual(calls(host, "threads.unpin"), []);
  assert.deepEqual(calls(host, "threads.update"), [{ threadId: "thr_b", sectionId: ARCHIVE.id }]);
});

test("a pinned thread already in the archive section is still unpinned", async () => {
  const host = await load();
  const thread = makeThreadResponse({ id: "thr_c", sectionId: ARCHIVE.id, pinnedAt: 1000 });
  await host.archive(thread);

  assert.deepEqual(calls(host, "threads.unpin"), [{ threadId: "thr_c" }]);
  assert.deepEqual(calls(host, "threads.update"), []);
});

test("unarchiving restores both the previous section and the pin", async () => {
  const host = await load();
  await host.archive(makeThreadResponse({ id: "thr_d", sectionId: WORK.id, pinnedAt: 1000 }));
  await host.unarchive("thr_d");

  assert.deepEqual(calls(host, "threads.update").at(-1), { threadId: "thr_d", sectionId: WORK.id });
  assert.deepEqual(calls(host, "threads.pin"), [{ threadId: "thr_d" }]);
});

test("unarchiving a thread that was not pinned does not pin it", async () => {
  const host = await load();
  await host.archive(makeThreadResponse({ id: "thr_e", sectionId: WORK.id }));
  await host.unarchive("thr_e");

  assert.deepEqual(calls(host, "threads.pin"), []);
});

test("the sweep unpins archived threads that are still pinned", async () => {
  const host = await load([
    makeThreadResponse({ id: "thr_f", sectionId: ARCHIVE.id, pinnedAt: 1000, archivedAt: 5 }),
    makeThreadResponse({ id: "thr_g", sectionId: ARCHIVE.id, pinnedAt: null, archivedAt: 5 }),
  ]);
  const result = await host.harness.runCli(["sweep", "--json"]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls(host, "threads.unpin"), [{ threadId: "thr_f" }]);
  assert.deepEqual(JSON.parse(result.stdout ?? "").moved.map((t: { id: string }) => t.id), ["thr_f"]);
});

test("a move that failed after the unpin keeps the pin for the retry", async () => {
  const host = await load();
  host.failNext("threads.update");
  await host.archive(makeThreadResponse({ id: "thr_h", sectionId: WORK.id, pinnedAt: 1000 })).catch(() => {});
  // The thread is now unpinned but still in Work; the sweep finishes the move.
  await host.harness.runCli(["sweep"]);
  assert.equal(host.store.get("thr_h")!.sectionId, ARCHIVE.id);

  await host.unarchive("thr_h");
  assert.equal(host.store.get("thr_h")!.sectionId, WORK.id);
  assert.notEqual(host.store.get("thr_h")!.pinnedAt, null);
});

test("unarchive acts on live state, not the event's stale snapshot", async () => {
  const host = await load();
  await host.archive(makeThreadResponse({ id: "thr_i", sectionId: WORK.id, pinnedAt: 1000 }));
  // Snapshot captured before the plugin moved and unpinned the thread.
  host.store.get("thr_i")!.archivedAt = null;
  await host.harness.emitThreadEvent("thread.unarchived", {
    thread: makeThreadResponse({ id: "thr_i", sectionId: WORK.id, pinnedAt: 1000 }),
  });

  assert.equal(host.store.get("thr_i")!.sectionId, WORK.id);
  assert.notEqual(host.store.get("thr_i")!.pinnedAt, null);
});

test("a thread the user moved out of the archive section is left alone, pin included", async () => {
  const host = await load();
  await host.archive(makeThreadResponse({ id: "thr_j", sectionId: WORK.id, pinnedAt: 1000 }));
  host.store.get("thr_j")!.sectionId = "sec_other";
  await host.unarchive("thr_j");

  assert.equal(host.store.get("thr_j")!.sectionId, "sec_other");
  assert.deepEqual(calls(host, "threads.pin"), []);
});
