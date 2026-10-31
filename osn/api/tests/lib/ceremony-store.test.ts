import { describe, expect, it, vi } from "vitest";

import { CEREMONY_STORE_MAX, createInMemoryCeremonyStore } from "../../src/lib/ceremony-store";
import { createDurableCeremonyStore } from "../../src/lib/coordination/durable";
import { createFakeNamespace } from "../helpers/coordination-namespace";

interface Entry {
  challenge: string;
  attempts: number;
  expiresAt: number;
}

const entry = (challenge: string, attempts = 0): Entry => ({
  challenge,
  attempts,
  expiresAt: Date.now() + 60_000,
});

describe("createInMemoryCeremonyStore", () => {
  it("set → get round-trips the value", async () => {
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge");
    await store.set("k1", entry("c1"), 60_000);
    expect(await store.get("k1")).toMatchObject({ challenge: "c1" });
  });

  it("get returns null for unknown / deleted keys", async () => {
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge");
    expect(await store.get("ghost")).toBe(null);
    await store.set("k", entry("c"), 60_000);
    await store.delete("k");
    expect(await store.get("k")).toBe(null);
  });

  it("expires entries past ttlMs (TTL expiry)", async () => {
    const store = createInMemoryCeremonyStore<Entry>("login_challenge");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      await store.set("k", entry("c"), 1_000);
      expect(await store.get("k")).toMatchObject({ challenge: "c" });
      vi.setSystemTime(new Date(1_000_000 + 2_000));
      expect(await store.get("k")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps expired entries on set at most once per debounce window (P-W1 cdl / P-W4)", async () => {
    const onEntryDelta = vi.fn();
    const store = createInMemoryCeremonyStore<Entry>("login_challenge", { onEntryDelta });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      await store.set("stale", entry("s"), 1_000); // first set sweeps (empty) + arms debounce

      // 5s later — "stale" is expired, but we are inside the 30s debounce
      // window, so a write does NOT trigger the O(n) sweep.
      vi.setSystemTime(new Date(1_000_000 + 5_000));
      await store.set("fresh1", entry("f1"), 60_000);
      expect(onEntryDelta).not.toHaveBeenCalledWith(-1, "login_challenge");

      // Past the debounce window — the next write sweeps and evicts "stale".
      vi.setSystemTime(new Date(1_000_000 + 40_000));
      await store.set("fresh2", entry("f2"), 60_000);
      expect(onEntryDelta).toHaveBeenCalledWith(-1, "login_challenge");
      expect(await store.get("stale")).toBe(null);
      expect(await store.get("fresh1")).not.toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries an updated attempts counter across set/get (attempts carry-over)", async () => {
    const store = createInMemoryCeremonyStore<Entry>("step_up_otp");
    await store.set("k", entry("c", 0), 60_000);
    const first = (await store.get("k"))!;
    await store.set("k", { ...first, attempts: first.attempts + 1 }, 60_000);
    expect((await store.get("k"))!.attempts).toBe(1);
  });

  it("bounds the map to CEREMONY_STORE_MAX entries", async () => {
    const store = createInMemoryCeremonyStore<Entry>("cross_device");
    for (let i = 0; i < CEREMONY_STORE_MAX + 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential insert
      await store.set(`k${i}`, entry(`c${i}`), 60_000);
    }
    // Oldest insertions dropped, newest retained.
    expect(await store.get("k0")).toBe(null);
    expect(await store.get(`k${CEREMONY_STORE_MAX + 4}`)).not.toBe(null);
  });

  it("evicts expired entries before FIFO-dropping live ones on a cap breach (T-S1)", async () => {
    const onEntryDelta = vi.fn();
    const store = createInMemoryCeremonyStore<Entry>("cross_device", { onEntryDelta });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      // Fill past the cap (CEREMONY_STORE_MAX + 1 — the bound check runs
      // BEFORE each insert, so the breach is only observed on the next set)
      // with three short-TTL entries interleaved among long-TTL live ones.
      // "live-0" is the OLDEST live insertion — first in FIFO order.
      const shortIndices = new Set([100, 5_000, 9_000]);
      for (let i = 0; i < CEREMONY_STORE_MAX + 1; i++) {
        if (shortIndices.has(i)) {
          // eslint-disable-next-line no-await-in-loop -- sequential insert
          await store.set(`short-${i}`, entry(`s${i}`), 1_000);
        } else {
          // eslint-disable-next-line no-await-in-loop -- sequential insert
          await store.set(`live-${i}`, entry(`l${i}`), 600_000);
        }
      }
      expect(onEntryDelta).not.toHaveBeenCalledWith(-1, "cross_device");

      // Advance past the short TTLs but WITHIN the 30s sweep debounce — the
      // debounced TTL sweep is still armed from the first set, so only the
      // cap-breach path can evict.
      vi.setSystemTime(new Date(1_000_000 + 5_000));
      await store.set("extra", entry("x"), 600_000);

      // The breach swept the three expired entries (size drops back under the
      // cap), so NO live entry was FIFO-dropped: exactly 3 evictions.
      const evictions = onEntryDelta.mock.calls.filter(
        ([delta, ns]) => delta === -1 && ns === "cross_device",
      );
      expect(evictions).toHaveLength(3);
      for (const i of shortIndices) {
        // eslint-disable-next-line no-await-in-loop -- sequential read
        expect(await store.get(`short-${i}`)).toBe(null);
      }
      // The oldest LIVE key survived — expired entries were preferred over
      // FIFO-dropping live insertions.
      expect(await store.get("live-0")).toMatchObject({ challenge: "l0" });
      expect(await store.get("extra")).toMatchObject({ challenge: "x" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits op + entry-delta observer hooks", async () => {
    const onOp = vi.fn();
    const onEntryDelta = vi.fn();
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge", { onOp, onEntryDelta });
    await store.set("k", entry("c"), 60_000);
    await store.get("k");
    await store.delete("k");
    expect(onOp).toHaveBeenCalledWith("set", "reg_challenge");
    expect(onEntryDelta).toHaveBeenCalledWith(1, "reg_challenge");
    expect(onEntryDelta).toHaveBeenCalledWith(-1, "reg_challenge");
  });
});

/**
 * The single-use claim. `get`-then-`delete` is not the same guarantee: two
 * concurrent presentations of one single-use secret can both pass a `get`
 * before either `delete` lands, and both then do the guarded work. Every store
 * that guards a one-shot secret goes through `consume` for that reason.
 */
describe("CeremonyStore.consume — first consumer wins", () => {
  it("memory: exactly one of two racing claims wins", async () => {
    const store = createInMemoryCeremonyStore<Entry>("recovery_disown");
    await store.set("k", entry("c"), 60_000);
    const results = await Promise.all([store.consume("k"), store.consume("k")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get("k")).toBe(null);
  });

  it("an absent key is not a claim", async () => {
    const store = createInMemoryCeremonyStore<Entry>("recovery_disown");
    expect(await store.consume("nothing-here")).toBe(false);
  });

  it("memory: an expired entry is removed but wins nothing", async () => {
    const store = createInMemoryCeremonyStore<Entry>("recovery_disown");
    await store.set("k", entry("c"), 1);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(50);
      expect(await store.consume("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A guess is counted on the entry it is a guess at, in the same call that
 * reads it, so no guess can read the entry and then count from a fresh
 * number. `take` is the single-use read: the value, removed in the same call.
 * The Durable Object store gives both the same guarantees (F-DO12–17).
 */
describe("CeremonyStore.guess and take", () => {
  it("counts nothing, and stores nothing, when there is no live entry", async () => {
    const store = createInMemoryCeremonyStore<Entry>("step_up_otp");
    expect(await store.guess("ghost")).toEqual({ value: null, n: 0 });
    expect(await store.get("ghost")).toBe(null);
    await store.set("k", entry("c"), 1);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(50);
      expect(await store.guess("k")).toEqual({ value: null, n: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts each guess on the entry and answers the value with the count", async () => {
    const store = createInMemoryCeremonyStore<Entry>("step_up_otp");
    await store.set("k", entry("c"), 60_000);
    const results = await Promise.all([store.guess("k"), store.guess("k"), store.guess("k")]);
    expect(results.map((r) => r.n).toSorted()).toEqual([1, 2, 3]);
    expect(results.every((r) => r.value?.challenge === "c")).toBe(true);
  });

  it("set restarts the count; delete and consume clear it with the entry", async () => {
    const store = createInMemoryCeremonyStore<Entry>("step_up_otp");
    await store.set("k", entry("first"), 60_000);
    await store.guess("k");
    await store.guess("k");
    await store.set("k", entry("second"), 60_000);
    expect(await store.guess("k")).toMatchObject({ value: { challenge: "second" }, n: 1 });

    await store.delete("k");
    await store.set("k", entry("third"), 60_000);
    expect((await store.guess("k")).n).toBe(1);

    expect(await store.consume("k")).toBe(true);
    await store.set("k", entry("fourth"), 60_000);
    expect((await store.guess("k")).n).toBe(1);
  });

  it("take answers the live value once and removes it", async () => {
    const store = createInMemoryCeremonyStore<Entry>("login_challenge");
    await store.set("k", entry("c"), 60_000);
    const results = await Promise.all([store.take("k"), store.take("k")]);
    expect(results.filter((r) => r?.challenge === "c")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await store.get("k")).toBe(null);
    expect(await store.take("absent")).toBe(null);
  });

  it("take answers null for an expired entry", async () => {
    const store = createInMemoryCeremonyStore<Entry>("login_challenge");
    await store.set("k", entry("c"), 1);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(50);
      expect(await store.take("k")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `swap` is the store's compare-and-set: from `null` it writes only where
 * nothing is live, and from a value `get` answered it replaces only that
 * value. Of several swaps from one value, one wins. Both builders answer
 * alike; the Durable Object store compares the JSON it stored (F-DO18–21).
 */
describe.each([
  ["memory", () => createInMemoryCeremonyStore<Entry>("cross_device")],
  [
    "durable_object",
    () => createDurableCeremonyStore<Entry>(createFakeNamespace().ns, "cross_device", vi.fn()),
  ],
] as const)("CeremonyStore.swap (%s)", (_backend, build) => {
  it("from null writes where nothing is live, and keeps a live entry and its count", async () => {
    const store = build();
    const first = entry("first");
    expect(await store.swap("k", null, first, 60_000)).toBe(true);
    expect(await store.get("k")).toEqual(first);
    await store.guess("k");
    expect(await store.swap("k", null, entry("second"), 60_000)).toBe(false);
    expect(await store.guess("k")).toEqual({ value: first, n: 2 });
  });

  it("from a value get answered replaces only that value, and restarts the count", async () => {
    const store = build();
    await store.set("k", entry("pending"), 60_000);
    await store.guess("k");
    const read = await store.get("k");
    const decided = entry("decided");
    expect(await store.swap("k", entry("other"), decided, 60_000)).toBe(false);
    expect(await store.swap("k", read, decided, 60_000)).toBe(true);
    expect(await store.guess("k")).toEqual({ value: decided, n: 1 });
    expect(await store.swap("k", read, entry("late"), 60_000)).toBe(false);
    expect(await store.swap("absent", read, decided, 60_000)).toBe(false);
    expect(await store.get("absent")).toBeNull();
  });

  it("lets exactly one of several swaps from one value win", async () => {
    const store = build();
    await store.set("k", entry("pending"), 60_000);
    const read = await store.get("k");
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.swap("k", read, entry(`decided-${i}`), 60_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

/**
 * A `delete` or a `consume` that names the value it read removes only that
 * value: a `set` that landed since — a new `begin` at the same key — keeps its
 * entry and its guess count, and the `consume` answers that it won nothing.
 * Both builders answer alike.
 */
describe.each([
  ["memory", () => createInMemoryCeremonyStore<Entry>("pending_email_change")],
  [
    "durable_object",
    () =>
      createDurableCeremonyStore<Entry>(createFakeNamespace().ns, "pending_email_change", vi.fn()),
  ],
] as const)("CeremonyStore.delete and consume with the value read (%s)", (_backend, build) => {
  it("consume leaves a value written since, with its count, and wins nothing", async () => {
    const store = build();
    await store.set("k", entry("guessed"), 60_000);
    const { value: read } = await store.guess("k");
    const fresh = entry("fresh");
    await store.set("k", fresh, 60_000);
    await store.guess("k");
    expect(await store.consume("k", read!)).toBe(false);
    expect(await store.guess("k")).toEqual({ value: fresh, n: 2 });
  });

  it("consume removes the value it read, and wins", async () => {
    const store = build();
    await store.set("k", entry("guessed"), 60_000);
    const { value: read } = await store.guess("k");
    expect(await store.consume("k", read!)).toBe(true);
    expect(await store.guess("k")).toEqual({ value: null, n: 0 });
    expect(await store.consume("k", read!)).toBe(false);
  });

  it("leaves a value written since, with its count", async () => {
    const store = build();
    await store.set("k", entry("completed"), 60_000);
    const { value: read } = await store.guess("k");
    const fresh = entry("fresh");
    await store.set("k", fresh, 60_000);
    await store.guess("k");
    await store.delete("k", read!);
    expect(await store.guess("k")).toEqual({ value: fresh, n: 2 });
  });

  it("removes the value it read, with its count", async () => {
    const store = build();
    await store.set("k", entry("completed"), 60_000);
    const { value: read } = await store.guess("k");
    await store.delete("k", read!);
    expect(await store.guess("k")).toEqual({ value: null, n: 0 });
  });
});
