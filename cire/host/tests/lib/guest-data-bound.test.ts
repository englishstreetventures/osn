import { describe, expect, it } from "vitest";

import type { GuestDataBound } from "../../src/components/CreateWeddingForm";
import { guestDataBoundWords } from "../../src/lib/guest-data-bound";

/**
 * The words of the warning a wedding's owners and editors see when the
 * guest-data sweep is close to, or past, deleting its guest list three years
 * after the wedding was created. The API decides the state and the day; these
 * tests hold how the portal says it.
 */

const bound = (patch: Partial<GuestDataBound> = {}): GuestDataBound => ({
  state: "near",
  reason: "unreadable-date",
  from: "2026-11-30T12:00:00.000Z",
  events: ["Ceremony"],
  eventCount: 1,
  ...patch,
});

describe("guestDataBoundWords", () => {
  it("names one event", () => {
    expect(guestDataBoundWords(bound())?.detail).toContain(
      "Cire can't read the date and time of this event: Ceremony,",
    );
  });

  it("joins two or three names as a list", () => {
    expect(
      guestDataBoundWords(bound({ events: ["Ceremony", "Reception"], eventCount: 2 }))?.detail,
    ).toContain("of these events: Ceremony and Reception,");
  });

  it("counts the events past the names it was sent", () => {
    expect(
      guestDataBoundWords(bound({ events: ["Ceremony", "Reception", "Party"], eventCount: 5 }))
        ?.detail,
    ).toContain("of these events: Ceremony, Reception, Party and 2 more,");
  });

  it("calls an event with no name what the editor calls it", () => {
    expect(
      guestDataBoundWords(bound({ events: ["", "Reception"], eventCount: 2 }))?.detail,
    ).toContain("of these events: Untitled event and Reception,");
  });

  // The unit project runs at Australia/Sydney, eleven hours ahead of UTC in
  // November: the bound's own day in UTC would be a day early there.
  it("prints the day in the reader's own zone", () => {
    expect(guestDataBoundWords(bound({ from: "2026-11-29T14:00:00.000Z" }))?.headline).toBe(
      "From 30 November 2026, Cire will delete this wedding's guest list.",
    );
  });

  it("says nothing of a state or a reason it does not know", () => {
    expect(guestDataBoundWords(bound({ state: "soon" as GuestDataBound["state"] }))).toBeNull();
    expect(guestDataBoundWords(bound({ reason: "other" as GuestDataBound["reason"] }))).toBeNull();
    expect(guestDataBoundWords(bound({ from: "not a date" }))).toBeNull();
  });

  // The list's names come from a second read; an editor save between the two
  // can leave none. The sentence still reads.
  it("speaks of one of its events when it was sent no names", () => {
    const words = guestDataBoundWords(bound({ events: [], eventCount: 0 }));
    expect(words?.detail).toContain("Cire can't read the date and time of one of its events,");
    expect(words?.detail).not.toContain(": ,");
  });

  it("words each state and reason with its own tone and action", () => {
    expect(guestDataBoundWords(bound())).toMatchObject({ tone: "warn", action: "Edit events" });
    expect(guestDataBoundWords(bound({ reason: "no-events", events: [] }))).toMatchObject({
      tone: "warn",
      action: "Add an event",
    });
    expect(guestDataBoundWords(bound({ state: "passed" }))).toMatchObject({
      tone: "danger",
      headline: "Cire is deleting this wedding's guest list.",
      action: "Edit events",
    });
    expect(
      guestDataBoundWords(bound({ state: "passed", reason: "no-events", events: [] })),
    ).toMatchObject({ tone: "danger", action: "Add an event" });
  });
});
