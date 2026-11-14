// @vitest-environment happy-dom
import { AuthExpiredError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindScope,
  invalidatePages,
  pageQuery,
  placeholderRows,
  scopeMark,
  type PageQuery,
  type PageRead,
  useSessionScope,
} from "../../src/lib/page-cache";

/**
 * The page cache in isolation: one test for each way it can fail, as listed in
 * the branch's plan. The refusals (a profile, account or session seeing
 * another's rows) stay whatever else covers navigation.
 */

// The session `AuthProvider` would hold: an object while signed in, `null` while not.
const [session, setSession] = createSignal<object | null>(null);
// Getters, not `Object.assign`, which would copy each value once.
const auth = {
  session: Object.defineProperties(() => session(), {
    state: { get: () => "ready" },
    latest: { get: () => session() },
    loading: { get: () => false },
    error: { get: () => undefined },
  }),
};

/** Each call is a read held until the test answers it. */
function heldReads<T>() {
  const calls: { resolve: (value: T) => void; reject: (err: unknown) => void }[] = [];
  const read = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { read, calls };
}

/** Mounts one reader of `query`, as a page would; `dispose` unmounts it. */
function mount<A extends unknown[], T>(query: PageQuery<A, T>, args: () => A | undefined) {
  return createRoot((dispose) => {
    let read!: PageRead<T>;
    AuthContext.Provider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the cache reads
      value: auth as any,
      get children() {
        read = query.use(args);
        return null;
      },
    });
    return { read, dispose };
  });
}

/** What `AppShell` mounts for as long as the shell is up: the scope follows the session with no page mounted. */
function shellBinder() {
  return createRoot((dispose) => {
    AuthContext.Provider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the cache reads
      value: auth as any,
      get children() {
        useSessionScope();
        return null;
      },
    });
    return dispose;
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let names = 0;
/** A query name no other test has used, so no count carries over. */
const fresh = () => `test.${(names += 1)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  setSession(null);
  vi.useRealTimers();
});

describe("scope: one account or profile never reads another's rows", () => {
  it("F1: a profile switch clears the first profile's rows, even for the same key later", async () => {
    const a = {};
    const b = {};
    setSession(a);
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const reader = mount(q, () => []);
    calls[0]!.resolve(["a-row"]);
    await settle();
    expect(reader.read()).toEqual(["a-row"]);

    setSession(b);
    expect(reader.read()).toBeUndefined();
    expect(reader.read.state).toBe("pending");

    // A's own session again: the key A's rows were held under. Only the clear
    // keeps them out.
    setSession(a);
    expect(reader.read()).toBeUndefined();
    expect(reader.read.state).toBe("pending");
    expect(read).toHaveBeenCalledTimes(3);
    reader.dispose();
  });

  it("F2: signing out clears every entry, so the next sign-in shows none of them", async () => {
    const a = {};
    setSession(a);
    const shell = shellBinder();
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const first = mount(q, () => []);
    calls[0]!.resolve(["a-row"]);
    await settle();
    first.dispose();

    // No page reads the rows while the session goes and comes back.
    setSession(null);
    setSession(a);
    const next = mount(q, () => []);
    expect(next.read()).toBeUndefined();
    expect(next.read.state).toBe("pending");
    next.dispose();
    shell();
  });

  it("F3: a read sent under one session that answers after the switch lands nowhere", async () => {
    const name = fresh();
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(name, read, (v) => v.length);
    const reader = mount(q, () => []);

    setSession({});
    calls[0]!.resolve(["a1", "a2", "a3", "a4"]);
    await settle();
    expect(reader.read()).toBeUndefined();
    expect(placeholderRows(name)).toBe(1);

    calls[1]!.resolve(["b-row"]);
    await settle();
    expect(reader.read()).toEqual(["b-row"]);
    reader.dispose();
  });

  it("F4: signed out, a preload sends nothing", () => {
    setSession(null);
    bindScope(null);
    const { read } = heldReads<string[]>();
    pageQuery(fresh(), read, (v) => v.length).preload();
    expect(read).not.toHaveBeenCalled();
  });

  it("F5: the row count a page last saw goes with its scope", async () => {
    const name = fresh();
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(name, read, (v) => v.length);
    const reader = mount(q, () => []);
    calls[0]!.resolve(["1", "2", "3", "4"]);
    await settle();
    expect(reader.read.rows).toBe(4);

    setSession({});
    expect(placeholderRows(name)).toBe(1);
    expect(reader.read.rows).toBe(1);
    reader.dispose();
  });

  it("F14: a mutation's answer taken under one scope is not written into the next", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const reader = mount(q, () => []);
    calls[0]!.resolve(["a-row"]);
    await settle();
    const mark = scopeMark();

    setSession({});
    calls[1]!.resolve(["b-row"]);
    await settle();
    q.update([], () => ["a-new"], mark);
    expect(reader.read()).toEqual(["b-row"]);
    reader.dispose();
  });
});

describe("reads", () => {
  it("F7: a read refused because the session went leaves no error behind", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const reader = mount(
      pageQuery(fresh(), read, (v) => v.length),
      () => [],
    );
    calls[0]!.reject(new AuthExpiredError({}));
    await settle();
    expect(reader.read.state).not.toBe("errored");
    expect(() => reader.read()).not.toThrow();
    reader.dispose();
  });

  it("F8: a read sent before a mutation never overwrites what came after it", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const first = mount(q, () => []);
    calls[0]!.resolve(["bob", "carol"]);
    await settle();
    first.dispose();

    // Shown again: the rows at once, a read behind them.
    const reader = mount(q, () => []);
    expect(calls).toHaveLength(2);
    q.update([], (rows) => rows.filter((r) => r !== "bob"), scopeMark());
    q.invalidate();
    expect(calls).toHaveLength(3);
    calls[2]!.resolve(["carol", "dan"]);
    await settle();
    calls[1]!.resolve(["bob", "carol"]);
    await settle();
    expect(reader.read()).toEqual(["carol", "dan"]);
    reader.dispose();
  });

  it("F8: a read out for rows no page shows is dropped when they go out of date", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    q.preload();
    q.invalidate();
    calls[0]!.resolve(["from before the mutation"]);
    await settle();

    const reader = mount(q, () => []);
    expect(reader.read()).toBeUndefined();
    expect(reader.read.state).toBe("pending");
    expect(read).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("F17: a page marked stale by name, from outside its queries, is read again", async () => {
    setSession({});
    const name = fresh();
    const { read, calls } = heldReads<string[]>();
    const reader = mount(
      pageQuery(name, read, (v) => v.length),
      () => [],
    );
    calls[0]!.resolve(["bob"]);
    await settle();
    invalidatePages(name, "never.registered");
    expect(read).toHaveBeenCalledTimes(2);
    expect(reader.read()).toEqual(["bob"]);
    reader.dispose();
  });

  it("F9: each visit reads once, behind the rows it shows; a preload never re-reads landed rows", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const first = mount(q, () => []);
    calls[0]!.resolve(["bob"]);
    await settle();
    first.dispose();

    const second = mount(q, () => []);
    expect(second.read.state).toBe("ready");
    expect(second.read()).toEqual(["bob"]);
    expect(read).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(["bob", "carol"]);
    await settle();
    expect(second.read()).toEqual(["bob", "carol"]);
    second.dispose();

    q.preload();
    expect(read).toHaveBeenCalledTimes(2);

    // Rows never read: a preload reads once, not again while it is out, and
    // not again once it failed (that waits for the page to be shown).
    const other = heldReads<string[]>();
    const p = pageQuery(fresh(), other.read, (v) => v.length);
    p.preload();
    p.preload();
    expect(other.read).toHaveBeenCalledTimes(1);
    other.calls[0]!.reject(new Error("refused"));
    await settle();
    p.preload();
    expect(other.read).toHaveBeenCalledTimes(1);
  });

  it("F18: a read that answers the same rows keeps the same row objects", async () => {
    setSession({});
    type Row = { handle: string };
    const { read, calls } = heldReads<{ rows: Row[] }>();
    const q = pageQuery(fresh(), read, (v) => v.rows.length);
    const first = mount(q, () => []);
    calls[0]!.resolve({ rows: [{ handle: "bob" }, { handle: "carol" }] });
    await settle();
    const before = first.read()!;
    first.dispose();

    const same = mount(q, () => []);
    calls[1]!.resolve({ rows: [{ handle: "bob" }, { handle: "carol" }] });
    await settle();
    expect(same.read()).toBe(before);
    same.dispose();

    const changed = mount(q, () => []);
    calls[2]!.resolve({ rows: [{ handle: "dan" }, { handle: "bob" }] });
    await settle();
    expect(changed.read()!.rows[1]).toBe(before.rows[0]);
    expect(changed.read()!.rows).toHaveLength(2);
    changed.dispose();
  });

  it("F10: a read that fails takes the old rows with it", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const first = mount(q, () => []);
    calls[0]!.resolve(["bob"]);
    await settle();
    first.dispose();

    const reader = mount(q, () => []);
    const failure = new Error("boom");
    calls[1]!.reject(failure);
    await settle();
    expect(reader.read.state).toBe("errored");
    expect(reader.read.error).toBe(failure);
    expect(() => reader.read()).toThrow(failure);
    reader.dispose();
  });

  it("F11: a failed entry shown again is read again, not thrown again", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const first = mount(q, () => []);
    calls[0]!.reject(new Error("boom"));
    await settle();
    first.dispose();

    const reader = mount(q, () => []);
    expect(reader.read.state).toBe("pending");
    expect(() => reader.read()).not.toThrow();
    expect(reader.read()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("F13: a mounted reader of a failed entry sends nothing more on its own", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const reader = mount(
      pageQuery(fresh(), read, (v) => v.length),
      () => [],
    );
    calls[0]!.reject(new Error("refused"));
    for (let i = 0; i < 5; i += 1) await settle();
    expect(read).toHaveBeenCalledTimes(1);
    reader.dispose();
  });

  it("F15: settled() waits for the read that is out, and gives nothing once the scope moved", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const first = mount(q, () => []);
    calls[0]!.resolve(["bob", "carol"]);
    await settle();
    first.dispose();

    const reader = mount(q, () => []);
    const settled = reader.read.settled();
    calls[1]!.resolve(["carol"]);
    await expect(settled).resolves.toEqual(["carol"]);
    reader.dispose();

    const again = mount(q, () => []);
    const moved = again.read.settled();
    setSession({});
    await expect(moved).resolves.toBeUndefined();
    again.dispose();
  });

  it("F16: refresh() settles when its read is dropped by a scope change", async () => {
    setSession({});
    const { read, calls } = heldReads<string[]>();
    const q = pageQuery(fresh(), read, (v) => v.length);
    const reader = mount(q, () => []);
    calls[0]!.resolve(["app"]);
    await settle();

    const refreshed = q.refresh();
    expect(reader.read.state).toBe("refreshing");
    setSession({});
    await expect(refreshed).resolves.toBeUndefined();
    reader.dispose();
  });
});
