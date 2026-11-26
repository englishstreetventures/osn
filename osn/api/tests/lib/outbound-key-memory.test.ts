import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublishedArcKey } from "../../src/lib/outbound-arc";
import {
  ABSENT_MEMORY_MAX,
  createOutboundKeyMemory,
  FOUND_KEY_HELD_MS,
  READ_SHARED_MS,
} from "../../src/lib/outbound-key-memory";

/**
 * One isolate's memory of osn-api's published keys: what it holds, for how
 * long, and what cannot make it stop answering a real key. Each read is
 * counted; the route's tests count the database statements.
 */

const KEY: PublishedArcKey = {
  kty: "EC",
  crv: "P-256",
  x: "x",
  y: "y",
  kid: "k.1.m",
  alg: "ES256",
  use: "sig",
};

afterEach(() => vi.restoreAllMocks());

/** A read that answers `key` and counts itself. */
const counting = (key: PublishedArcKey | null) => {
  const reads = { count: 0 };
  return { reads, read: async () => (reads.count++, key) };
};

describe("osn-api's key memory", () => {
  it("lets a new ask read when the read it would share has run past five seconds", async () => {
    const memory = createOutboundKeyMemory();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    // The first ask's read never settles, as when its request is cancelled.
    void memory.answer("k.1", () => new Promise<PublishedArcKey | null>(() => {}), true);
    clock.mockReturnValue(start + READ_SHARED_MS);
    const { reads, read } = counting(KEY);
    expect(await memory.answer("k.1", read, true)).toEqual({ key: KEY, read: true, full: false });
    expect(reads.count).toBe(1);
    expect(await memory.answer("k.1", read, true)).toEqual({ key: KEY, read: false, full: false });
  });

  it("holds a key found however many absences fill their own map", async () => {
    const memory = createOutboundKeyMemory();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const none = counting(null);
    for (let i = 0; i < ABSENT_MEMORY_MAX * 2; i++) {
      // eslint-disable-next-line no-await-in-loop -- one ask at a time
      await memory.answer(`absent.${i}`, none.read, true);
    }
    const { reads, read } = counting(KEY);
    await memory.answer("k.1", read, true);
    await memory.answer("k.1", read, true);
    expect(reads.count).toBe(1);
    // An absence past the cap is not held: it is read again.
    const before = none.reads.count;
    await memory.answer(`absent.${ABSENT_MEMORY_MAX * 2 - 1}`, none.read, true);
    expect(none.reads.count).toBe(before + 1);
    // One within the cap is.
    await memory.answer("absent.0", none.read, true);
    expect(none.reads.count).toBe(before + 1);
  });

  it("never holds an absence it was not asked to", async () => {
    const memory = createOutboundKeyMemory();
    const { reads, read } = counting(null);
    await memory.answer("k.1", read, false);
    await memory.answer("k.1", read, false);
    expect(reads.count).toBe(2);
    expect(memory.held("k.1")).toBeUndefined();
  });

  it("counts a key's minute from when its read started", async () => {
    const memory = createOutboundKeyMemory();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    let reads = 0;
    await memory.answer(
      "k.1",
      async () => {
        reads++;
        clock.mockReturnValue(start + 10_000);
        return KEY;
      },
      true,
    );
    clock.mockReturnValue(start + FOUND_KEY_HELD_MS - 1);
    expect(memory.held("k.1")).toEqual({ key: KEY });
    clock.mockReturnValue(start + FOUND_KEY_HELD_MS);
    expect(memory.held("k.1")).toBeUndefined();
    expect(reads).toBe(1);
  });
});
