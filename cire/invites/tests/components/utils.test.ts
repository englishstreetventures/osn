import { describe, it, expect } from "vitest";

import { isValidClaimResponse, isValidRsvpSaveResponse } from "../../src/components/utils";

describe("isValidClaimResponse", () => {
  const baseEvent = {
    id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
    name: "Mehndi",
    description: "An evening of henna",
    startAt: "2026-09-18T16:00:00+10:00",
    endAt: "2026-09-18T22:00:00+10:00",
    timezone: "Australia/Sydney",
    address: "12 Banksia Lane, Strathfield",
    dressCodeDescription: "Bright, festive colours",
    dressCodePalette: [{ name: "Marigold", color: "oklch(76% 0.15 75)" }],
    pinterestUrl: "https://www.pinterest.com/",
    mapsUrl: "https://maps.google.com/",
    sortOrder: 0,
  };

  const validResponse = {
    publicId: "SHARMA-JOY-RK97",
    familyName: "Sharma",
    members: [
      {
        guestId: "guest-1",
        firstName: "Priya",
        lastName: "Sharma",
        eventIds: ["mehndi", "reception"],
      },
      { guestId: "guest-2", firstName: "Raj", lastName: "Sharma", eventIds: ["reception"] },
    ],
    events: [baseEvent],
    rsvps: [
      {
        guestId: "guest-1",
        eventId: "mehndi",
        status: "attending",
        dietary: "",
        dietaryPresets: ["vegetarian"],
        dietaryConsentCurrent: true,
      },
    ],
  };

  it("accepts a valid response", () => {
    expect(isValidClaimResponse(validResponse)).toBe(true);
  });

  it("accepts a response with empty members and events arrays", () => {
    expect(
      isValidClaimResponse({
        publicId: "TEST-ABC-XY12",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: [],
      }),
    ).toBe(true);
  });

  it("accepts events with null optional fields", () => {
    expect(
      isValidClaimResponse({
        publicId: "T",
        familyName: "T",
        members: [],
        events: [
          {
            ...baseEvent,
            address: null,
            dressCodeDescription: null,
            dressCodePalette: null,
            pinterestUrl: null,
            mapsUrl: null,
          },
        ],
        rsvps: [],
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidClaimResponse(null)).toBe(false);
  });

  it("rejects a string", () => {
    expect(isValidClaimResponse("hello")).toBe(false);
  });

  it("rejects missing publicId", () => {
    expect(isValidClaimResponse({ familyName: "Test", members: [], events: [] })).toBe(false);
  });

  it("rejects non-string publicId", () => {
    expect(
      isValidClaimResponse({ publicId: 123, familyName: "Test", members: [], events: [] }),
    ).toBe(false);
  });

  it("rejects missing familyName", () => {
    expect(isValidClaimResponse({ publicId: "X", members: [], events: [] })).toBe(false);
  });

  it("rejects non-string familyName", () => {
    expect(isValidClaimResponse({ publicId: "X", familyName: 42, members: [], events: [] })).toBe(
      false,
    );
  });

  it("rejects missing members", () => {
    expect(isValidClaimResponse({ publicId: "X", familyName: "Test", events: [] })).toBe(false);
  });

  it("rejects non-array members", () => {
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: "nope", events: [] }),
    ).toBe(false);
  });

  it("rejects missing events", () => {
    expect(isValidClaimResponse({ publicId: "X", familyName: "Test", members: [] })).toBe(false);
  });

  it("rejects non-array events", () => {
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: [], events: "not-array" }),
    ).toBe(false);
  });

  it("rejects members missing guestId", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ firstName: "Jane", lastName: "Doe", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with missing firstName", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ guestId: "g1", lastName: "Doe", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with missing lastName", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ guestId: "g1", firstName: "Jane", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with non-array eventIds", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ guestId: "g1", firstName: "Jane", lastName: "Doe", eventIds: "bad" }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects events with missing id", () => {
    const { id: _id, ...rest } = baseEvent;
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [rest],
      }),
    ).toBe(false);
  });

  it("rejects events with missing name", () => {
    const { name: _name, ...rest } = baseEvent;
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [rest],
      }),
    ).toBe(false);
  });

  it("rejects events with missing startAt", () => {
    const { startAt: _s, ...rest } = baseEvent;
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: [], events: [rest] }),
    ).toBe(false);
  });

  it("rejects events with non-string timezone", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, timezone: 7 }],
      }),
    ).toBe(false);
  });

  it("rejects events with non-string address (other than null)", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, address: 42 }],
      }),
    ).toBe(false);
  });

  it("rejects events with malformed dressCodePalette", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, dressCodePalette: [{ name: "X" }] }],
      }),
    ).toBe(false);
  });

  it("rejects missing rsvps", () => {
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: [], events: [] }),
    ).toBe(false);
  });

  it("rejects non-array rsvps", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: "nope",
      }),
    ).toBe(false);
  });

  it("rejects rsvps with unknown status", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: [{ guestId: "g1", eventId: "e1", status: "yolo", dietary: "" }],
      }),
    ).toBe(false);
  });

  it("rejects rsvps with non-string dietary", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: [{ guestId: "g1", eventId: "e1", status: "attending", dietary: 42 }],
      }),
    ).toBe(false);
  });

  describe("the two dietary fields", () => {
    // Nothing orders this site's production deploy after the API's, and both
    // callers read `false` as "no session" — so a field this guard insists on
    // would send every signed-in household back to the code form whenever the
    // site reached production first. Absence degrades; a wrong type still fails.
    const base = { guestId: "g1", eventId: "e1", status: "attending", dietary: "" };
    const wrap = (rsvp: unknown) => ({
      publicId: "X",
      familyName: "Test",
      members: [],
      events: [],
      rsvps: [rsvp],
    });

    it("accepts a row carrying neither, as an API that predates them sends it", () => {
      expect(isValidClaimResponse(wrap(base))).toBe(true);
    });

    it("accepts a row carrying only one of them", () => {
      expect(isValidClaimResponse(wrap({ ...base, dietaryPresets: ["vegan"] }))).toBe(true);
      expect(isValidClaimResponse(wrap({ ...base, dietaryConsentCurrent: true }))).toBe(true);
    });

    it("rejects dietaryPresets that is present but not an array of strings", () => {
      for (const dietaryPresets of ["vegetarian", [42], ["vegan", 42], null, {}]) {
        expect(
          isValidClaimResponse(wrap({ ...base, dietaryPresets, dietaryConsentCurrent: true })),
        ).toBe(false);
      }
    });

    it("accepts a preset key this build does not know", () => {
      // The vocabulary grows server-first; rejecting here would strand a guest
      // on an older deploy of this site.
      expect(
        isValidClaimResponse(
          wrap({ ...base, dietaryPresets: ["a_future_key"], dietaryConsentCurrent: true }),
        ),
      ).toBe(true);
    });

    it("rejects dietaryConsentCurrent that is present but not a boolean", () => {
      // It decides whether the consent box may open ticked; a truthy non-boolean
      // must never be read as consent.
      for (const dietaryConsentCurrent of ["yes", 1, null]) {
        expect(
          isValidClaimResponse(wrap({ ...base, dietaryPresets: [], dietaryConsentCurrent })),
        ).toBe(false);
      }
      expect(
        isValidClaimResponse(wrap({ ...base, dietaryPresets: [], dietaryConsentCurrent: false })),
      ).toBe(true);
    });
  });

  it("rejects events with non-number sortOrder", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, sortOrder: "0" }],
      }),
    ).toBe(false);
  });
});

describe("isValidRsvpSaveResponse", () => {
  // The save response carries the same rows as the claim response, and they
  // replace the page's copy, so they are held to the same row check.
  const row = {
    guestId: "g1",
    eventId: "e1",
    status: "attending",
    dietary: "",
    dietaryPresets: ["vegan"],
    dietaryConsentCurrent: true,
  };

  it("accepts rows the claim guard would accept", () => {
    expect(isValidRsvpSaveResponse({ rsvps: [row] })).toBe(true);
    expect(isValidRsvpSaveResponse({ rsvps: [] })).toBe(true);
  });

  it("accepts rows lacking the two dietary fields, as the claim guard does", () => {
    const { dietaryPresets: _p, dietaryConsentCurrent: _c, ...bare } = row;
    expect(isValidRsvpSaveResponse({ rsvps: [bare] })).toBe(true);
  });

  it("rejects a body with no rows array, or a row of the wrong shape", () => {
    for (const body of [null, "ok", {}, { rsvps: "x" }]) {
      expect(isValidRsvpSaveResponse(body)).toBe(false);
    }
    expect(isValidRsvpSaveResponse({ rsvps: [{ ...row, dietaryPresets: "nuts" }] })).toBe(false);
    expect(isValidRsvpSaveResponse({ rsvps: [{ ...row, status: "yolo" }] })).toBe(false);
    expect(isValidRsvpSaveResponse({ rsvps: [{ ...row, dietaryConsentCurrent: "yes" }] })).toBe(
      false,
    );
  });
});
