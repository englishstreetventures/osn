import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Miniflare } from "miniflare";

import { MAX_TTL_MS } from "../../src/client";
import type { StoreDump } from "./fixtures/store-worker";

/**
 * CoordinationStore on real workerd. Atomicity under concurrent calls, alarms
 * and SQLite-backed storage exist only in the runtime, so a stand-in would
 * test the stand-in. Same tier and build recipe as
 * `shared/realtime/tests/d1/hub.test.ts`.
 *
 * Expiry is real wall-clock time: windows and TTLs are a few hundred
 * milliseconds, and every wait leaves at least 150 ms either side of an edge.
 */

const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 15_000;
const NAN = "__NaN__";

let script: string;
let mf: Miniflare;
const persistDirs: string[] = [];

async function boot(persist?: string): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script,
    // osn-api's date and flags (`osn/api/wrangler.toml`).
    compatibilityDate: "2025-03-01",
    compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    durableObjects: { STORE: { className: "ObservedStore", useSQLite: true } },
    ...(persist === undefined ? {} : { durableObjectsPersist: persist }),
  });
}

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dirname}/fixtures/store-worker.ts`],
    format: "esm",
    target: "node",
    // Provided by workerd itself: there is nothing to bundle.
    external: ["cloudflare:workers"],
  });
  if (!built.success) throw new AggregateError(built.logs, "fixture build failed");
  script = await built.outputs[0]!.text();
  mf = await boot();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
  await Promise.all(persistDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Lets wall-clock time pass. */
const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { ok: true; result: unknown } | { ok: false; name: string; message: string };

async function send(target: Miniflare, body: Record<string, unknown>): Promise<Outcome> {
  const res = await target.dispatchFetch("http://store.example.test/", {
    method: "POST",
    body: JSON.stringify(body, (_key, value: unknown) =>
      typeof value === "number" && Number.isNaN(value) ? NAN : value,
    ),
  });
  return (await res.json()) as Outcome;
}

/** Calls `op` on the object called `name`; throws if the object refused. */
async function call<T>(name: string, op: string, ...args: unknown[]): Promise<T> {
  const outcome = await send(mf, { name, op, args });
  if (!outcome.ok) throw new Error(`${op} refused: ${outcome.message}`);
  return outcome.result as T;
}

/** Calls `op` and returns the refusal; fails if the object accepted. */
async function refusal(name: string, op: string, ...args: unknown[]) {
  const outcome = await send(mf, { name, op, args });
  if (outcome.ok) throw new Error(`${op}(${String(args)}) was accepted`);
  return outcome;
}

const dump = (name: string) => call<StoreDump>(name, "dump");
const guess = (name: string) => call<{ value: string | null; n: number }>(name, "guess");
const EMPTY: StoreDump = { keys: [], alarm: null };

/** Poll in short steps until `check` holds, or fail after `timeoutMs`. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await elapse(25);
  }
}

describe("CoordinationStore", () => {
  // F-DO1
  it(
    "counts 1..n within a window anchored at the first hit, then starts again at 1",
    async () => {
      const name = "do1";
      expect(await call<number>(name, "increment", 600)).toBe(1);
      expect(await call<number>(name, "increment", 600)).toBe(2);
      expect(await call<number>(name, "increment", 600)).toBe(3);
      await elapse(300);
      // A hit inside the window does not move its end.
      expect(await call<number>(name, "increment", 600)).toBe(4);
      await elapse(450);
      expect(await call<number>(name, "increment", 600)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO2
  it(
    "answers N concurrent increments with exactly 1..N",
    async () => {
      const n = 25;
      const results = await Promise.all(
        Array.from({ length: n }, () => call<number>("do2", "increment", 60_000)),
      );
      expect(results.toSorted((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO3
  it(
    "reads a value before its TTL and null after, even while the entry is still stored",
    async () => {
      const name = "do3";
      await call(name, "write", "v1", 300);
      expect(await call<string | null>(name, "read")).toBe("v1");
      await call(name, "cancelAlarm");
      await elapse(450);
      expect(await call<string | null>(name, "read")).toBeNull();
      // Nothing removed it: the read itself honoured the TTL.
      expect((await dump(name)).keys).toEqual(["entry"]);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO4
  it(
    "overwrites on write and restarts the TTL",
    async () => {
      const name = "do4";
      await call(name, "write", "first", 400);
      await elapse(250);
      await call(name, "write", "second", 400);
      await elapse(250);
      expect(await call<string | null>(name, "read")).toBe("second");
      await elapse(350);
      expect(await call<string | null>(name, "read")).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO5
  it(
    "removes: true for a live entry, false when absent or expired, empty after",
    async () => {
      await call("do5-live", "write", "v", 60_000);
      expect(await call<boolean>("do5-live", "remove")).toBe(true);
      expect(await call<string | null>("do5-live", "read")).toBeNull();
      expect(await dump("do5-live")).toEqual(EMPTY);

      expect(await call<boolean>("do5-absent", "remove")).toBe(false);

      await call("do5-expired", "write", "v", 200);
      await call("do5-expired", "cancelAlarm");
      await elapse(350);
      expect(await call<boolean>("do5-expired", "remove")).toBe(false);
      expect(await dump("do5-expired")).toEqual(EMPTY);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO5
  it(
    "lets exactly one of two concurrent removes see the entry",
    async () => {
      await call("do5-race", "write", "v", 60_000);
      const results = await Promise.all([
        call<boolean>("do5-race", "remove"),
        call<boolean>("do5-race", "remove"),
      ]);
      expect(results.toSorted()).toEqual([false, true]);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO6
  it(
    "claims once per TTL, and again after it",
    async () => {
      const name = "do6";
      expect(await call<boolean>(name, "claim", 400)).toBe(true);
      expect(await call<boolean>(name, "claim", 400)).toBe(false);
      await elapse(550);
      expect(await call<boolean>(name, "claim", 400)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO6
  it(
    "lets exactly one of ten concurrent claims win",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => call<boolean>("do6-race", "claim", 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO7
  it(
    "empties the object once its entry has expired and the alarm has run",
    async () => {
      await call("do7-value", "write", "v", 300);
      await call("do7-count", "increment", 300);
      await call("do7-claim", "claim", 300);
      for (const name of ["do7-value", "do7-count", "do7-claim"]) {
        expect((await dump(name)).alarm).not.toBeNull();
      }
      for (const name of ["do7-value", "do7-count", "do7-claim"]) {
        await until(
          async () => JSON.stringify(await dump(name)) === JSON.stringify(EMPTY),
          `${name} to empty`,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO8
  it(
    "keeps an entry rewritten with a later TTL when an older alarm runs",
    async () => {
      const name = "do8";
      await call(name, "write", "old", 200);
      await call(name, "write", "new", 60_000);
      await elapse(350);
      expect(await call<string | null>(name, "read")).toBe("new");
      // The older alarm delivered anyway, after its own deadline.
      await call(name, "fireAlarm");
      expect(await call<string | null>(name, "read")).toBe("new");
      const { keys, alarm } = await dump(name);
      expect(keys).toEqual(["entry"]);
      expect(alarm).toBeGreaterThan(Date.now() + 50_000);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO9
  describe.each(["increment", "claim"])("%s refuses a bad duration", (op) => {
    it.each([0, -1, Number.NaN, 1.5, MAX_TTL_MS + 1])(
      "%p, and writes nothing",
      async (ms) => {
        const name = `do9-${op}-${String(ms)}`;
        const refused = await refusal(name, op, ms);
        expect(refused.name).toBe("RangeError");
        expect(refused.message).not.toContain(name);
        expect(await dump(name)).toEqual(EMPTY);
      },
      TEST_TIMEOUT_MS,
    );
  });

  // F-DO9
  it.each([Number.NaN, 1.5, MAX_TTL_MS + 1])(
    "write refuses TTL %p and writes nothing",
    async (ms) => {
      const name = `do9-write-${String(ms)}`;
      const refused = await refusal(name, "write", "v", ms);
      expect(refused.name).toBe("RangeError");
      expect(refused.message).not.toContain(name);
      expect(await dump(name)).toEqual(EMPTY);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "write refuses a value that is not a string",
    async () => {
      const refused = await refusal("do9-write-value", "write", 42, 60_000);
      expect(refused.name).toBe("TypeError");
      expect(await dump("do9-write-value")).toEqual(EMPTY);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([0, -1])(
    "write with TTL %p removes the entry without an error",
    async (ms) => {
      const name = `write-remove-${ms}`;
      await call(name, "write", "v", 60_000);
      await call(name, "write", "w", ms);
      expect(await call<string | null>(name, "read")).toBeNull();
      expect(await dump(name)).toEqual(EMPTY);
      // On an absent entry it is a no-op.
      await call(name, "write", "w", ms);
      expect(await dump(name)).toEqual(EMPTY);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO10
  it(
    "counts live hits, and 0 when absent or expired",
    async () => {
      expect(await call<number>("do10-absent", "count")).toBe(0);
      await call("do10-live", "increment", 60_000);
      await call("do10-live", "increment", 60_000);
      expect(await call<number>("do10-live", "count")).toBe(2);
      await call("do10-expired", "increment", 200);
      await call("do10-expired", "cancelAlarm");
      await elapse(350);
      expect(await call<number>("do10-expired", "count")).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO12
  it(
    "guess on no live entry stores nothing and counts nothing, also once it has expired",
    async () => {
      expect(await guess("do12-absent")).toEqual({ value: null, n: 0 });
      expect(await dump("do12-absent")).toEqual(EMPTY);

      await call("do12-expired", "write", "v", 200);
      await call("do12-expired", "cancelAlarm");
      await elapse(350);
      expect(await guess("do12-expired")).toEqual({ value: null, n: 0 });
      expect(await call<number>("do12-expired", "count")).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO13
  it(
    "guess on a live entry counts on it and keeps its value and expiry",
    async () => {
      const name = "do13";
      await call(name, "write", "code", 600);
      const before = (await dump(name)).alarm;
      expect(await guess(name)).toEqual({ value: "code", n: 1 });
      expect(await guess(name)).toEqual({ value: "code", n: 2 });
      expect(await call<number>(name, "count")).toBe(2);
      expect(await call<string | null>(name, "read")).toBe("code");
      expect((await dump(name)).alarm).toBe(before);
      await elapse(750);
      expect(await guess(name)).toEqual({ value: null, n: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO14
  it(
    "answers N concurrent guesses with exactly 1..N",
    async () => {
      await call("do14", "write", "code", 60_000);
      const n = 25;
      const results = await Promise.all(
        Array.from({ length: n }, () => call<{ value: string; n: number }>("do14", "guess")),
      );
      expect(results.every((r) => r.value === "code")).toBe(true);
      expect(results.map((r) => r.n).toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: n }, (_, i) => i + 1),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO15
  it(
    "write restarts the count; remove clears the value and the count together",
    async () => {
      const name = "do15";
      await call(name, "write", "first", 60_000);
      await guess(name);
      await guess(name);
      await call(name, "write", "second", 60_000);
      expect(await guess(name)).toEqual({ value: "second", n: 1 });
      expect(await call<boolean>(name, "remove")).toBe(true);
      expect(await dump(name)).toEqual(EMPTY);
      expect(await guess(name)).toEqual({ value: null, n: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO16
  it(
    "take answers the live value once and leaves the object empty",
    async () => {
      await call("do16", "write", "challenge", 60_000);
      expect(await call<string | null>("do16", "take")).toBe("challenge");
      expect(await dump("do16")).toEqual(EMPTY);
      expect(await call<string | null>("do16", "take")).toBeNull();

      expect(await call<string | null>("do16-absent", "take")).toBeNull();
      expect(await dump("do16-absent")).toEqual(EMPTY);

      await call("do16-expired", "write", "v", 200);
      await call("do16-expired", "cancelAlarm");
      await elapse(350);
      expect(await call<string | null>("do16-expired", "take")).toBeNull();
      expect(await dump("do16-expired")).toEqual(EMPTY);
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO17
  it(
    "lets exactly one of two concurrent takes have the value",
    async () => {
      await call("do17", "write", "challenge", 60_000);
      const results = await Promise.all([
        call<string | null>("do17", "take"),
        call<string | null>("do17", "take"),
      ]);
      expect(results.filter((r) => r === "challenge")).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the client addresses <namespace>:<key> on a real binding",
    async () => {
      const written = await send(mf, {
        namespace: "ceremony",
        key: "acct_1",
        op: "write",
        args: ["v", 60_000],
      });
      expect(written.ok).toBe(true);
      expect(await call<string | null>("ceremony:acct_1", "read")).toBe("v");
    },
    TEST_TIMEOUT_MS,
  );

  // F-DO11
  it(
    "keeps its state across a restart on the same storage",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "coordination-store-"));
      persistDirs.push(dir);
      const first = await boot(dir);
      try {
        for (const op of ["increment", "increment"]) {
          const outcome = await send(first, { name: "do11-count", op, args: [60_000] });
          expect(outcome.ok).toBe(true);
        }
        const wrote = await send(first, {
          name: "do11-value",
          op: "write",
          args: ["kept", 60_000],
        });
        expect(wrote.ok).toBe(true);
      } finally {
        await first.dispose();
      }
      const second = await boot(dir);
      try {
        expect(await send(second, { name: "do11-count", op: "count", args: [] })).toEqual({
          ok: true,
          result: 2,
        });
        expect(await send(second, { name: "do11-value", op: "read", args: [] })).toEqual({
          ok: true,
          result: "kept",
        });
      } finally {
        await second.dispose();
      }
    },
    HOOK_TIMEOUT_MS,
  );
});
