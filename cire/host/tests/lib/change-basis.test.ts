import { afterEach, describe, expect, it } from "vitest";

import { __resetChangeBasis, basisFor, dropBasis, recordBasis } from "../../src/lib/change-basis";

/**
 * The change editors seed a draft from cached rows only under a basis: rows
 * read after a head the editor read, unchanged since. A basis given back
 * wrongly pairs a head with rows older than it, and a save would then read a
 * co-host's row as removed. Each case is one way the answer could be wrong.
 */

const events = [{ id: "evt_1" }];
const guests = [{ id: "gst_1" }];
const households = [{ id: "fam_1" }];

const fresh = (rows: readonly unknown[] | null) => ({ rows, fresh: true });

describe("basisFor", () => {
  afterEach(() => {
    __resetChangeBasis();
  });

  it("gives nothing when no basis was recorded", () => {
    expect(basisFor("wed_1", { events: fresh(events) })).toBeNull();
  });

  it("gives nothing once a slice's rows were reloaded or patched", () => {
    recordBasis("wed_1", "7", { events, guests });
    expect(basisFor("wed_1", { events: fresh([...events]), guests: fresh(guests) })).toBeNull();
  });

  it("gives nothing while a slice is marked stale", () => {
    recordBasis("wed_1", "7", { events });
    expect(basisFor("wed_1", { events: { rows: events, fresh: false } })).toBeNull();
  });

  it("gives nothing when the slices were read after different heads", () => {
    recordBasis("wed_1", "7", { events, guests, households });
    recordBasis("wed_1", "8", { events });
    expect(
      basisFor("wed_1", {
        events: fresh(events),
        guests: fresh(guests),
        households: fresh(households),
      }),
    ).toBeNull();
  });

  it("gives the head when every slice is the one read after it", () => {
    recordBasis("wed_1", "7", { events, guests, households });
    expect(
      basisFor("wed_1", {
        events: fresh(events),
        guests: fresh(guests),
        households: fresh(households),
      }),
    ).toBe("7");
    // The events editor asks for its one slice.
    expect(basisFor("wed_1", { events: fresh(events) })).toBe("7");
  });

  it("gives nothing for a slice no editor recorded", () => {
    // The events editor opened first; the guests editor then asks for all three.
    recordBasis("wed_1", "7", { events });
    expect(
      basisFor("wed_1", {
        events: fresh(events),
        guests: fresh(guests),
        households: fresh(households),
      }),
    ).toBeNull();
  });

  it("keeps the other slices' basis when an editor records its own again", () => {
    recordBasis("wed_1", "7", { events, guests });
    const reloaded = [{ id: "evt_1" }];
    recordBasis("wed_1", "7", { events: reloaded });
    expect(basisFor("wed_1", { events: fresh(reloaded), guests: fresh(guests) })).toBe("7");
  });

  it("gives nothing after the wedding is dropped", () => {
    recordBasis("wed_1", "7", { events });
    dropBasis("wed_1");
    expect(basisFor("wed_1", { events: fresh(events) })).toBeNull();
  });
});
