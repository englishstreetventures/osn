import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { type D1QueryClient, withD1Session } from "../../src/db/d1-session";
import { effectDbFor } from "../../src/db/effect-handle";
import { counterValue } from "../test-helpers/metrics-harness";
import { fakeD1 } from "./effect-handle-fake-d1";

const memory = () => new Database(":memory:");
const binding = (db: Database, onPrepare?: (q: string) => void) =>
  // Safety: `effectDbFor` takes a D1Database; the fake answers the members the shim calls.
  fakeD1(db, onPrepare) as unknown as Parameters<typeof effectDbFor>[0];

describe("effectDbFor", () => {
  // one handle per (binding, entry), including two calls in the same tick.
  it("H1: returns the same handle for the same binding and entry, even when called twice in one tick", () => {
    const b = binding(memory());
    const first = effectDbFor(b, "fetch");
    const second = effectDbFor(b, "fetch");
    expect(first).toBe(second);
  });

  // a different binding gets its own handle.
  it("H2: a different binding gets a different handle", () => {
    const one = binding(memory());
    const two = binding(memory());
    expect(effectDbFor(one, "fetch")).not.toBe(effectDbFor(two, "fetch"));
  });

  // the entry label is kept apart, and each entry's fallback query counts under its own label.
  it("H3: fetch and scheduled keep separate handles and separate session-missing labels", async () => {
    const b = binding(memory());
    const fetchHandle = effectDbFor(b, "fetch");
    const scheduledHandle = effectDbFor(b, "scheduled");
    expect(fetchHandle).not.toBe(scheduledHandle);

    const fetchBefore = await counterValue("cire.d1.session_missing", { entry: "fetch" });
    const scheduledBefore = await counterValue("cire.d1.session_missing", { entry: "scheduled" });

    // No session in scope: the query falls back to the binding and counts under the entry's label.
    await Effect.runPromise(fetchHandle.all(sql`select 1 as one`));

    expect((await counterValue("cire.d1.session_missing", { entry: "fetch" })) - fetchBefore).toBe(
      1,
    );
    expect(
      (await counterValue("cire.d1.session_missing", { entry: "scheduled" })) - scheduledBefore,
    ).toBe(0);

    // The scheduled handle counts under its own label, and the fetch label is unchanged by it.
    const fetchAfterFetch = await counterValue("cire.d1.session_missing", { entry: "fetch" });
    await Effect.runPromise(scheduledHandle.all(sql`select 2 as two`));
    expect(
      (await counterValue("cire.d1.session_missing", { entry: "scheduled" })) - scheduledBefore,
    ).toBe(1);
    expect(await counterValue("cire.d1.session_missing", { entry: "fetch" })).toBe(fetchAfterFetch);
  });

  // queries from two concurrent request sessions each ride their own session.
  it("H7: two concurrent sessions each prepare their own queries", async () => {
    const b = binding(memory());
    const handle = effectDbFor(b, "fetch");
    const logA: string[] = [];
    const logB: string[] = [];
    const sessionA = fakeD1(memory(), (q) => logA.push(q));
    const sessionB = fakeD1(memory(), (q) => logB.push(q));

    const runIn = (session: D1QueryClient, query: string) =>
      withD1Session(session, () => Effect.runPromise(handle.all(sql.raw(query))));

    await Promise.all([runIn(sessionA, "select 'a' as who"), runIn(sessionB, "select 'b' as who")]);

    expect(logA).toContain("select 'a' as who");
    expect(logA).not.toContain("select 'b' as who");
    expect(logB).toContain("select 'b' as who");
    expect(logB).not.toContain("select 'a' as who");
  });
});
