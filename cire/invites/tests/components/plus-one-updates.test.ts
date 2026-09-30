import { describe, expect, it } from "vitest";

import {
  hasUnansweredEvents,
  isValidPlusOneSaveResponse,
  plusOneOf,
  plusOneRefusalMessage,
  withPlusOneRemoved,
  withPlusOneSaved,
} from "../../src/components/plus-one-updates";
import type {
  ClaimResult,
  FamilyMember,
  PlusOneSaved,
  RsvpSummary,
} from "../../src/components/types";

const bo: FamilyMember = {
  guestId: "g-bo",
  firstName: "Bo",
  lastName: "Lee",
  nickname: null,
  eventIds: ["e1", "e2"],
  plusOneAllowed: true,
  plusOneOf: null,
};
const cleo: FamilyMember = {
  guestId: "g-cleo",
  firstName: "Cleo",
  lastName: "Lee",
  nickname: null,
  eventIds: ["e1"],
  plusOneAllowed: false,
  plusOneOf: null,
};
const sam: FamilyMember = {
  guestId: "g-sam",
  firstName: "Sam",
  lastName: "Park",
  nickname: null,
  eventIds: ["e1", "e2"],
  plusOneAllowed: false,
  plusOneOf: "g-bo",
};

const reply = (
  guestId: string,
  eventId: string,
  extra: Partial<RsvpSummary> = {},
): RsvpSummary => ({
  guestId,
  eventId,
  status: "attending",
  dietary: "",
  dietaryPresets: [],
  dietaryConsentCurrent: false,
  ...extra,
});

function household(members: FamilyMember[], rsvps: RsvpSummary[] = []): ClaimResult {
  return { publicId: "LEE-OAK-AB12", familyName: "Lee", members, events: [], rsvps };
}

const saved = (
  overrides: Partial<PlusOneSaved["plusOne"]> = {},
  extra: Partial<PlusOneSaved> = {},
) => ({
  plusOne: {
    guestId: "g-sam",
    firstName: "Sam",
    lastName: "Park",
    plusOneOf: "g-bo",
    eventIds: ["e1", "e2"],
    ...overrides,
  },
  created: true,
  ...extra,
});

describe("plusOneOf", () => {
  it("finds the plus-one a member brought", () => {
    expect(plusOneOf([bo, sam, cleo], "g-bo")).toBe(sam);
    expect(plusOneOf([bo, sam, cleo], "g-cleo")).toBeUndefined();
  });
});

describe("withPlusOneSaved", () => {
  it("places a new plus-one straight after the member who brought them", () => {
    const next = withPlusOneSaved(household([bo, cleo]), saved());
    expect(next.members.map((m) => m.guestId)).toEqual(["g-bo", "g-sam", "g-cleo"]);
    // Everything the rest of the page reads from a member, filled in.
    expect(next.members[1]).toEqual({
      guestId: "g-sam",
      firstName: "Sam",
      lastName: "Park",
      nickname: null,
      eventIds: ["e1", "e2"],
      plusOneAllowed: false,
      plusOneOf: "g-bo",
    });
  });

  it("renames in place and keeps the replies when nothing was cleared", () => {
    const rows = [reply("g-sam", "e1", { dietaryPresets: ["nuts"], dietaryConsentCurrent: true })];
    const next = withPlusOneSaved(
      household([bo, sam, cleo], rows),
      saved({ firstName: "Samuel" }, { created: false }),
    );
    expect(next.members.map((m) => m.firstName)).toEqual(["Bo", "Samuel", "Cleo"]);
    expect(next.rsvps).toEqual(rows);
  });

  it("drops the page's copy of the dietary answers the server cleared, and keeps the status", () => {
    const rows = [
      reply("g-sam", "e1", {
        dietary: "No sesame",
        dietaryPresets: ["nuts", "other"],
        dietaryConsentCurrent: true,
      }),
      reply("g-bo", "e1", { dietaryPresets: ["vegan"], dietaryConsentCurrent: true }),
    ];
    const next = withPlusOneSaved(
      household([bo, sam], rows),
      saved({ firstName: "Alex" }, { created: false, dietaryCleared: true }),
    );
    expect(next.rsvps).toEqual([
      reply("g-sam", "e1", { dietary: "", dietaryPresets: [], dietaryConsentCurrent: false }),
      rows[1],
    ]);
  });

  it("replaces a stale plus-one the server no longer has, with their replies", () => {
    // Another device removed Sam and named Alex; this page still shows Sam.
    const next = withPlusOneSaved(
      household([bo, sam], [reply("g-sam", "e1")]),
      saved({ guestId: "g-alex", firstName: "Alex", lastName: "" }, { created: false }),
    );
    expect(next.members.map((m) => m.guestId)).toEqual(["g-bo", "g-alex"]);
    expect(next.rsvps).toEqual([]);
  });

  it("puts a plus-one whose inviter this page does not know at the end", () => {
    const next = withPlusOneSaved(household([cleo]), saved());
    expect(next.members.map((m) => m.guestId)).toEqual(["g-cleo", "g-sam"]);
  });

  it("leaves the result it was given untouched", () => {
    const before = household([bo, cleo]);
    withPlusOneSaved(before, saved());
    expect(before.members).toEqual([bo, cleo]);
  });
});

describe("withPlusOneRemoved", () => {
  it("takes the plus-one and their replies off the page, and nobody else's", () => {
    const next = withPlusOneRemoved(
      household([bo, sam, cleo], [reply("g-sam", "e1"), reply("g-bo", "e1")]),
      "g-bo",
    );
    expect(next.members.map((m) => m.guestId)).toEqual(["g-bo", "g-cleo"]);
    expect(next.rsvps.map((r) => r.guestId)).toEqual(["g-bo"]);
  });
});

describe("hasUnansweredEvents", () => {
  it("is true while any of the plus-one's events has no reply", () => {
    expect(hasUnansweredEvents(sam, [reply("g-sam", "e1")])).toBe(true);
    expect(hasUnansweredEvents(sam, [reply("g-sam", "e1"), reply("g-sam", "e2")])).toBe(false);
  });

  it("is false for someone invited to nothing", () => {
    expect(hasUnansweredEvents({ ...sam, eventIds: [] }, [])).toBe(false);
  });
});

describe("plusOneRefusalMessage", () => {
  it("names the closed RSVP window apart from any other 403", () => {
    expect(plusOneRefusalMessage(403, "rsvp_closed")).toMatch(/RSVPs have closed/);
    expect(plusOneRefusalMessage(403, "plus_one_not_allowed")).toMatch(/contact the couple/);
    expect(plusOneRefusalMessage(403, "Unauthorized")).toMatch(/re-enter your code/);
  });

  it("says the guest list is full on a capacity refusal", () => {
    expect(plusOneRefusalMessage(409, "guest_capacity")).toMatch(/guest list is full/);
  });

  it("gives every other status its own direction", () => {
    const messages = [
      plusOneRefusalMessage(400, "Missing or invalid fields"),
      plusOneRefusalMessage(401, "Unauthorized"),
      plusOneRefusalMessage(404, "guest_not_found"),
      plusOneRefusalMessage(409, "plus_one_cannot_invite"),
      plusOneRefusalMessage(413, "Payload too large"),
      plusOneRefusalMessage(429, undefined),
      plusOneRefusalMessage(500, undefined),
    ];
    expect(messages[0]).toMatch(/check the name/i);
    expect(messages[1]).toMatch(/re-enter your code/);
    expect(messages[2]).toMatch(/reload/i);
    expect(messages[3]).toMatch(/can't bring a guest of their own/);
    expect(messages[4]).toMatch(/shorter/);
    expect(messages[5]).toMatch(/try again in a moment/);
    expect(messages[6]).toMatch(/try again/);
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
  });
});

describe("isValidPlusOneSaveResponse", () => {
  const body = {
    plusOne: {
      guestId: "g-sam",
      firstName: "Sam",
      lastName: "",
      plusOneOf: "g-bo",
      eventIds: ["e1", "e2"],
    },
    created: true,
    dietaryCleared: false,
  };

  it("accepts the answer to a naming or a rename", () => {
    expect(isValidPlusOneSaveResponse(body)).toBe(true);
  });

  // An API that predates `dietaryCleared` also clears nothing on a rename.
  it("accepts an answer without dietaryCleared", () => {
    const { dietaryCleared: _d, ...older } = body;
    expect(isValidPlusOneSaveResponse(older)).toBe(true);
  });

  it("rejects anything the page could not place", () => {
    for (const bad of [
      null,
      {},
      { ...body, created: "yes" },
      { ...body, dietaryCleared: 1 },
      { ...body, plusOne: null },
      { ...body, plusOne: { ...body.plusOne, guestId: 3 } },
      { ...body, plusOne: { ...body.plusOne, firstName: undefined } },
      { ...body, plusOne: { ...body.plusOne, lastName: null } },
      { ...body, plusOne: { ...body.plusOne, plusOneOf: null } },
      { ...body, plusOne: { ...body.plusOne, eventIds: ["e1", 2] } },
    ]) {
      expect(isValidPlusOneSaveResponse(bad)).toBe(false);
    }
  });
});
