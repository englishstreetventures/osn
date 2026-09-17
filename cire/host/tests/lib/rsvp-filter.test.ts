import { describe, expect, it } from "vitest";

import {
  filterRows,
  mergeRows,
  type RsvpFilterEvent,
  RSVP_FILTERS,
  statusCounts,
} from "../../src/lib/rsvp-filter";

/**
 * The RSVP list's search + status filter. The payload arrives split in two —
 * `guests` (replied) and `unresponded` (invited, silent) — and the view shows
 * them as one list, so the merge and the predicate live here rather than in the
 * component.
 */

const CEREMONY: RsvpFilterEvent = {
  guests: [
    {
      guestId: "g1",
      firstName: "Ada",
      lastName: "Sharma",
      familyName: "Sharma",
      familyCode: "SHARMA-WIDGET-AB3K9",
      status: "attending",
      // Preset-only: nothing typed. The row a substring search over free text
      // could never find, which is the case this whole column exists for.
      dietary: "",
      dietaryPresets: ["gluten"],
      consentSource: "guest",
    },
    {
      guestId: "g2",
      firstName: "Bo",
      lastName: "Jones",
      familyName: "Jones",
      familyCode: "JONES-KITE-77Q2",
      status: "declined",
      dietary: "",
      dietaryPresets: [],
      consentSource: "organiser_attested",
    },
    {
      guestId: "g4",
      firstName: "Dev",
      lastName: "Rao",
      familyName: "Rao",
      familyCode: "RAO-EMBER-51X8",
      status: "maybe",
      // Preset plus an "Other" note that narrows it — both have to be findable.
      dietary: "Severe (airborne is fine, contact is not)",
      dietaryPresets: ["nuts", "other"],
      consentSource: "guest",
    },
  ],
  unresponded: [
    {
      guestId: "g3",
      firstName: "Cleo",
      lastName: "Jones",
      familyName: "Jones",
      familyCode: "JONES-KITE-77Q2",
    },
  ],
};

const RECEPTION: RsvpFilterEvent = {
  guests: [
    {
      guestId: "g1",
      firstName: "Ada",
      lastName: "Sharma",
      familyName: "Sharma",
      familyCode: "SHARMA-WIDGET-AB3K9",
      status: "attending",
      dietary: "",
      dietaryPresets: ["gluten"],
      consentSource: "guest",
    },
  ],
  unresponded: [],
};

const ids = (rows: ReturnType<typeof mergeRows>) => rows.map((r) => r.guestId);

describe("mergeRows", () => {
  it("puts replies first, then the silent guests as status 'none'", () => {
    const rows = mergeRows(CEREMONY);
    expect(ids(rows)).toEqual(["g1", "g2", "g4", "g3"]);
    expect(rows.at(-1)).toMatchObject({
      guestId: "g3",
      status: "none",
      dietary: "",
      responded: false,
    });
  });

  it("builds each row's search text once, lower-cased, over every matchable field", () => {
    const rows = mergeRows(CEREMONY);
    // Preset LABELS, not keys — `gluten` is stored, "Gluten / coeliac" is what
    // a host sees, says and therefore types. The trailing space is this row's
    // empty "Other" text.
    expect(rows[0]?.search).toBe("ada sharma sharma sharma-widget-ab3k9 gluten / coeliac ");
    // A silent guest has no dietary data at all, but is still searchable by
    // household.
    expect(rows[3]?.search).toBe("cleo jones jones jones-kite-77q2  ");
  });

  it("keeps the provenance of a reply and leaves it off a non-reply", () => {
    const rows = mergeRows(CEREMONY);
    expect(rows[1]).toMatchObject({ consentSource: "organiser_attested", responded: true });
    expect(rows[3]?.consentSource).toBeNull();
  });

  it("handles an event nobody has replied to", () => {
    expect(mergeRows({ guests: [], unresponded: [] })).toEqual([]);
  });
});

describe("filterRows", () => {
  const rows = mergeRows(CEREMONY);

  it("returns everything for the default filter and an empty query", () => {
    expect(ids(filterRows(rows, "", "all"))).toEqual(["g1", "g2", "g4", "g3"]);
  });

  it("narrows to one status, no-reply included", () => {
    expect(ids(filterRows(rows, "", "attending"))).toEqual(["g1"]);
    expect(ids(filterRows(rows, "", "declined"))).toEqual(["g2"]);
    expect(ids(filterRows(rows, "", "maybe"))).toEqual(["g4"]);
    expect(ids(filterRows(rows, "", "none"))).toEqual(["g3"]);
  });

  it("matches a name case-insensitively, first or last", () => {
    expect(ids(filterRows(rows, "ADA", "all"))).toEqual(["g1"]);
    expect(ids(filterRows(rows, "sharma", "all"))).toEqual(["g1"]);
  });

  it("matches a full name across the gap, however it is spaced", () => {
    expect(ids(filterRows(rows, "  ada   sharma ", "all"))).toEqual(["g1"]);
  });

  it("matches every term in any order, not the typed phrase", () => {
    expect(ids(filterRows(rows, "jones cleo", "all"))).toEqual(["g3"]);
  });

  it("matches the household name and the household code", () => {
    expect(ids(filterRows(rows, "jones", "all"))).toEqual(["g2", "g3"]);
    expect(ids(filterRows(rows, "kite-77q2", "all"))).toEqual(["g2", "g3"]);
  });

  it("matches dietary text, so a caterer can find an allergen", () => {
    expect(ids(filterRows(rows, "nut", "all"))).toEqual(["g4"]);
  });

  it("matches a preset a guest never typed, which free text alone could not", () => {
    // g1 picked "Gluten / coeliac" from the list and typed nothing. Before the
    // presets column there was no string on this row for "coeliac" to land on.
    expect(ids(filterRows(rows, "coeliac", "all"))).toEqual(["g1"]);
    expect(ids(filterRows(rows, "gluten", "all"))).toEqual(["g1"]);
  });

  it("matches a preset and its Other note on the same row", () => {
    // g4 is `nuts` + `other`, with the note narrowing it. Both halves are one
    // haystack, so either word finds the row and neither shadows the other.
    expect(ids(filterRows(rows, "nuts airborne", "all"))).toEqual(["g4"]);
  });

  it("matches punctuation inside a dietary note as typed", () => {
    expect(ids(filterRows(rows, "(airborne", "all"))).toEqual(["g4"]);
    expect(ids(filterRows(rows, "severe (airborne", "all"))).toEqual(["g4"]);
  });

  it("treats a whitespace-only query as no query at all", () => {
    expect(ids(filterRows(rows, "   ", "all"))).toEqual(["g1", "g2", "g4", "g3"]);
    expect(ids(filterRows(rows, " \t ", "attending"))).toEqual(["g1"]);
  });

  it("applies the query and the status together", () => {
    expect(ids(filterRows(rows, "jones", "none"))).toEqual(["g3"]);
    expect(ids(filterRows(rows, "jones", "attending"))).toEqual([]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterRows(rows, "zzzz", "all")).toEqual([]);
  });
});

describe("statusCounts", () => {
  it("sums each status across every event, with 'all' as the total", () => {
    expect(statusCounts([mergeRows(CEREMONY), mergeRows(RECEPTION)])).toEqual({
      all: 5,
      attending: 2,
      declined: 1,
      maybe: 1,
      none: 1,
    });
  });

  it("counts nothing for a wedding with no events", () => {
    expect(statusCounts([])).toEqual({ all: 0, attending: 0, declined: 0, maybe: 0, none: 0 });
  });

  it("counts the same rows the list renders, taking any iterable of groups", () => {
    const groups = new Map([
      ["evt_1", mergeRows(CEREMONY)],
      ["evt_2", mergeRows(RECEPTION)],
    ]);
    expect(statusCounts(groups.values())).toEqual(
      statusCounts([mergeRows(CEREMONY), mergeRows(RECEPTION)]),
    );
  });

  it("names every filter the chips render", () => {
    expect(RSVP_FILTERS.map((f) => f.key)).toEqual([
      "all",
      "attending",
      "declined",
      "maybe",
      "none",
    ]);
  });
});
