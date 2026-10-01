import { describe, expect, it } from "vitest";

import { mergeRows } from "../../src/lib/rsvp-filter";
import { applySavedReply, isSavedReply, type SavedReply } from "../../src/lib/rsvp-save";

/**
 * Folding the organiser PUT's stored row into one event of the view: the row
 * and the header counts move, nothing else does.
 */

const household = (guestId: string, firstName: string, familyCode: string) => ({
  guestId,
  firstName,
  lastName: "Test",
  familyName: familyCode,
  familyCode,
});

const EVENT = {
  attending: 1,
  declined: 0,
  maybe: 1,
  responded: 2,
  noResponse: 2,
  guests: [
    {
      ...household("a1", "Ada", "AAA"),
      status: "attending" as const,
      dietary: "",
      dietaryPresets: ["gluten"],
      consentSource: "guest" as const,
      submittedBy: { guestId: "a1", firstName: "Ada", viaLink: false },
    },
    {
      ...household("c1", "Cy", "CCC"),
      status: "maybe" as const,
      dietary: "",
      dietaryPresets: [],
      consentSource: "guest" as const,
    },
  ],
  unresponded: [household("a2", "Al", "AAA"), household("b1", "Bea", "BBB")],
};

const reply = (guestId: string, status: SavedReply["status"]): SavedReply => ({
  guestId,
  status,
  dietary: "",
  dietaryPresets: [],
  consentSource: "organiser_attested",
});

describe("applySavedReply", () => {
  it("moves one count from the old status to the new on an edited reply", () => {
    const next = applySavedReply(EVENT, { ...reply("a1", "declined"), consentSource: "guest" })!;
    expect(next).toMatchObject({ attending: 0, declined: 1, responded: 2, noResponse: 2 });
    const row = mergeRows(next).find((r) => r.guestId === "a1")!;
    expect(row).toMatchObject({
      status: "declined",
      consentSource: "guest",
      statusRecordedByHost: true,
      submittedBy: null,
    });
  });

  it("moves a first reply out of the silent list, after its household", () => {
    const next = applySavedReply(EVENT, reply("a2", "attending"))!;
    expect(next).toMatchObject({ attending: 2, responded: 3, noResponse: 1 });
    expect(next.guests.map((g) => g.guestId)).toEqual(["a1", "a2", "c1"]);
    expect(next.unresponded.map((g) => g.guestId)).toEqual(["b1"]);
  });

  it("places a household with no reply yet by its code", () => {
    const next = applySavedReply(EVENT, reply("b1", "maybe"))!;
    expect(next.guests.map((g) => g.guestId)).toEqual(["a1", "b1", "c1"]);
    expect(next.maybe).toBe(2);
  });

  it("puts a first reply from a household that sorts after every reply last", () => {
    const event = {
      ...EVENT,
      unresponded: [...EVENT.unresponded, household("z1", "Zed", "ZZZ")],
    };
    const next = applySavedReply(event, reply("z1", "attending"))!;
    expect(next.guests.map((g) => g.guestId)).toEqual(["a1", "c1", "z1"]);
  });

  it("leaves the counts as they were when the status is saved unchanged", () => {
    const next = applySavedReply(EVENT, reply("a1", "attending"))!;
    expect(next).toMatchObject({
      attending: 1,
      declined: 0,
      maybe: 1,
      responded: 2,
      noResponse: 2,
    });
  });

  it("never takes a count below zero", () => {
    const stale = { ...EVENT, attending: 0, noResponse: 0 };
    expect(applySavedReply(stale, reply("a1", "declined"))).toMatchObject({
      attending: 0,
      declined: 1,
    });
    expect(applySavedReply(stale, reply("a2", "maybe"))).toMatchObject({ noResponse: 0 });
  });

  it("answers null for a guest the page does not hold", () => {
    expect(applySavedReply(EVENT, reply("zz", "attending"))).toBeNull();
  });

  it("leaves the event it was given untouched", () => {
    const before = JSON.stringify(EVENT);
    applySavedReply(EVENT, reply("a2", "attending"));
    expect(JSON.stringify(EVENT)).toBe(before);
  });
});

describe("mergeRows and the host-write flag", () => {
  it("reads an absent flag, and a row nobody answered, as no host write", () => {
    const rows = mergeRows(EVENT);
    expect(rows.map((r) => [r.guestId, r.statusRecordedByHost])).toEqual([
      ["a1", false],
      ["c1", false],
      ["a2", false],
      ["b1", false],
    ]);
  });
});

describe("isSavedReply", () => {
  it("accepts the stored row the API answers with", () => {
    expect(isSavedReply(reply("a1", "attending"))).toBe(true);
  });

  it.each([
    null,
    { status: "attending" },
    { ...reply("a1", "attending"), status: "none" },
    { ...reply("a1", "attending"), consentSource: "someone" },
    { ...reply("a1", "attending"), dietaryPresets: [1] },
  ])("refuses %j", (value) => {
    expect(isSavedReply(value)).toBe(false);
  });
});
