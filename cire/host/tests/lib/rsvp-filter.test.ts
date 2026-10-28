import { describe, expect, it } from "vitest";

import {
  filterRows,
  mergeRows,
  nextSort,
  plusOneMarker,
  plusOneShort,
  type RsvpFilterEvent,
  type RsvpFilterInvitedGuest,
  RSVP_FILTERS,
  sortRows,
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

/**
 * A plus-one is a guest row like any other; the API adds who brought them
 * (`plusOneOf`, and that guest's name). The row carries both, and a search
 * finds a plus-one by the words the row shows beside their name.
 */
const WITH_PLUS_ONES: RsvpFilterEvent = {
  guests: [
    {
      guestId: "g2",
      firstName: "Bo",
      lastName: "Jones",
      familyName: "Jones",
      familyCode: "JONES-KITE-77Q2",
      status: "attending",
      dietary: "",
      dietaryPresets: [],
      consentSource: "guest",
      plusOneOf: null,
      plusOneOfName: null,
    },
    {
      guestId: "p1",
      firstName: "Sam",
      lastName: "Lee",
      familyName: "Jones",
      familyCode: "JONES-KITE-77Q2",
      status: "attending",
      dietary: "",
      dietaryPresets: [],
      consentSource: "inviter_attested",
      plusOneOf: "g2",
      plusOneOfName: "Bo Jones",
    },
  ],
  unresponded: [
    {
      guestId: "p2",
      firstName: "Kit",
      lastName: "",
      familyName: "Rao",
      familyCode: "RAO-EMBER-51X8",
      plusOneOf: "g4",
      plusOneOfName: "Dev Rao",
    },
    {
      guestId: "p3",
      firstName: "Ren",
      lastName: "",
      familyName: "Sharma",
      familyCode: "SHARMA-WIDGET-AB3K9",
      // An inviter the API could not name.
      plusOneOf: "g1",
      plusOneOfName: null,
    },
    {
      guestId: "p4",
      firstName: "Lu",
      lastName: "",
      familyName: "Okafor",
      familyCode: "OKAFOR-REED-90Z1",
      // An API that sends the link but predates the name: the key is absent.
      plusOneOf: "g5",
    },
  ],
};

describe("mergeRows — plus-ones", () => {
  it("carries who brought a plus-one, replied or silent, and null for everyone else", () => {
    const rows = mergeRows(WITH_PLUS_ONES);
    expect(rows.map((r) => [r.guestId, r.plusOneOf, r.plusOneOfName])).toEqual([
      ["g2", null, null],
      ["p1", "g2", "Bo Jones"],
      ["p2", "g4", "Dev Rao"],
      ["p3", "g1", null],
      ["p4", "g5", null],
    ]);
    expect(rows[1]?.consentSource).toBe("inviter_attested");
  });

  it("reads an API that does not send the fields as no plus-one at all", () => {
    // The portal can deploy before the API that adds them.
    const rows = mergeRows(CEREMONY);
    expect(rows.every((r) => r.plusOneOf === null && r.plusOneOfName === null)).toBe(true);
  });

  it("finds a plus-one by the words beside their name, and by who brought them", () => {
    const rows = mergeRows(WITH_PLUS_ONES);
    expect(ids(filterRows(rows, "plus-one", "all"))).toEqual(["p1", "p2", "p3", "p4"]);
    // An unnamed inviter is found by the words the row shows in their place.
    expect(ids(filterRows(rows, "another guest", "all"))).toEqual(["p3", "p4"]);
    expect(ids(filterRows(rows, "bo", "all"))).toEqual(["g2", "p1"]);
    expect(ids(filterRows(rows, "rao dev", "all"))).toEqual(["p2"]);
  });

  it("words the marker the way the row shows it", () => {
    const rows = mergeRows(WITH_PLUS_ONES);
    expect(rows.slice(1).map(plusOneMarker)).toEqual([
      "Plus-one of Bo Jones",
      "Plus-one of Dev Rao",
      "Plus-one of another guest",
      "Plus-one of another guest",
    ]);
  });

  it("shortens the marker to +1 and the inviter's first name for the eye", () => {
    // The row shows "+1 · Bo"; the full marker above is what a screen reader
    // and the search read. With no inviter named there is no name to show.
    const rows = mergeRows(WITH_PLUS_ONES);
    expect(rows.slice(1).map(plusOneShort)).toEqual(["+1 · Bo", "+1 · Dev", "+1", "+1"]);
    expect(plusOneShort({ plusOneOfName: "  Maximilian-Alexander  Wolfe " })).toBe(
      "+1 · Maximilian-Alexander",
    );
    expect(plusOneShort({ plusOneOfName: "" })).toBe("+1");
  });

  it("leaves an ordinary row's search text as it was", () => {
    expect(mergeRows(WITH_PLUS_ONES)[0]?.search).toBe("bo jones jones jones-kite-77q2  ");
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

  it("matches a preset key this build does not know, by the words in it", () => {
    // The portal can be a build older than the API, so a stored answer can carry
    // a key missing from this build's vocabulary. It is labelled from the key
    // ("lupin_flour" reads "Lupin flour"), and that label is what a search lands on.
    const withUnknown = mergeRows({
      guests: [
        {
          guestId: "g9",
          firstName: "Eli",
          lastName: "Park",
          familyName: "Park",
          familyCode: "PARK-OWL-12CD",
          status: "attending",
          dietary: "",
          dietaryPresets: ["lupin_flour"],
          consentSource: "guest",
        },
      ],
      unresponded: [],
    });
    expect(ids(filterRows(withUnknown, "lupin flour", "all"))).toEqual(["g9"]);
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

  it("keeps the order it is given, so a sorted list stays sorted", () => {
    const reversed = rows.toReversed();
    expect(ids(filterRows(reversed, "jones", "all"))).toEqual(["g3", "g2"]);
    expect(ids(filterRows(reversed, "", "all"))).toEqual(["g3", "g4", "g2", "g1"]);
  });
});

describe("statusCounts", () => {
  it("counts each status in one event's rows, with 'all' as the total", () => {
    expect(statusCounts(mergeRows(CEREMONY))).toEqual({
      all: 4,
      attending: 1,
      declined: 1,
      maybe: 1,
      none: 1,
    });
  });

  it("counts nothing for an event with no rows", () => {
    expect(statusCounts([])).toEqual({ all: 0, attending: 0, declined: 0, maybe: 0, none: 0 });
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

/**
 * The two sortable columns. Guest sorts by surname, so a family reads together
 * the way the Household column groups it; Household sorts whole households and
 * leaves each one in the order the API gave it, which is the couple's own order
 * with every plus-one after the guest who brought them.
 */
describe("sortRows", () => {
  const invited = (
    guestId: string,
    firstName: string,
    lastName: string,
    familyName = lastName,
    familyCode = `${familyName.toUpperCase()}-1`,
  ): RsvpFilterInvitedGuest => ({ guestId, firstName, lastName, familyName, familyCode });
  const rowsOf = (...guests: RsvpFilterInvitedGuest[]) =>
    mergeRows({ guests: [], unresponded: guests });
  const guestAsc = { key: "guest", direction: "ascending" } as const;
  const guestDesc = { key: "guest", direction: "descending" } as const;
  const householdAsc = { key: "household", direction: "ascending" } as const;
  const householdDesc = { key: "household", direction: "descending" } as const;

  it("sorts guests by surname, not by first name", () => {
    const rows = rowsOf(invited("g1", "Ada", "Young"), invited("g2", "Zoe", "Adams"));
    expect(ids(sortRows(rows, guestAsc))).toEqual(["g2", "g1"]);
  });

  it("breaks a shared surname by first name", () => {
    const rows = rowsOf(invited("g1", "Mei", "Chen"), invited("g2", "Al", "Chen"));
    expect(ids(sortRows(rows, guestAsc))).toEqual(["g2", "g1"]);
  });

  it("keeps the order it was given for two guests of the same name", () => {
    const rows = rowsOf(
      invited("g1", "Sam", "Lee", "Lee", "LEE-2"),
      invited("g2", "Sam", "Lee", "Lee", "LEE-1"),
    );
    expect(ids(sortRows(rows, guestAsc))).toEqual(["g1", "g2"]);
    expect(ids(sortRows(rows, guestDesc))).toEqual(["g1", "g2"]);
  });

  it("does not split a surname by case or accent", () => {
    const rows = rowsOf(
      invited("g1", "Bo", "de Vries"),
      invited("g2", "Kai", "Park"),
      invited("g3", "Al", "De Vries"),
      invited("g4", "Niamh", "Ó Súilleabháin"),
      invited("g5", "Ines", "Nguyen"),
    );
    // "de Vries" and "De Vries" are one surname, so first names order them;
    // "Ó" files with the Os, between Nguyen and Park.
    expect(ids(sortRows(rows, guestAsc))).toEqual(["g3", "g1", "g5", "g4", "g2"]);
  });

  it("puts a guest with no surname after every surname, in both directions", () => {
    const rows = rowsOf(
      invited("g1", "Mei", ""),
      invited("g2", "Ada", "Young"),
      invited("g3", "Kai", "  "),
      invited("g4", "Zoe", "Adams"),
    );
    expect(ids(sortRows(rows, guestAsc))).toEqual(["g4", "g2", "g3", "g1"]);
    expect(ids(sortRows(rows, guestDesc))).toEqual(["g2", "g4", "g1", "g3"]);
  });

  it("sorts a name stored with spaces round it as the name itself", () => {
    // A space pasted in from a spreadsheet would otherwise rank before every
    // letter and put " Zane" at the head of the list.
    const guests = rowsOf(
      invited("g1", "Ada", " Zane"),
      invited("g2", "Bo", "Adams"),
      invited("g3", "Cy", "Chen "),
    );
    expect(ids(sortRows(guests, guestAsc))).toEqual(["g2", "g3", "g1"]);
    expect(ids(sortRows(guests, guestDesc))).toEqual(["g1", "g3", "g2"]);
    const households = rowsOf(
      invited("g1", "Ada", "Park", " Park"),
      invited("g2", "Bo", "Adams", "Adams"),
    );
    expect(ids(sortRows(households, householdAsc))).toEqual(["g2", "g1"]);
    expect(ids(sortRows(households, householdDesc))).toEqual(["g1", "g2"]);
  });

  it("reverses the order when descending", () => {
    const rows = rowsOf(
      invited("g1", "Ada", "Young"),
      invited("g2", "Zoe", "Adams"),
      invited("g3", "Al", "Chen"),
      invited("g4", "Mei", "Chen"),
    );
    expect(ids(sortRows(rows, guestDesc))).toEqual(["g1", "g4", "g3", "g2"]);
  });

  it("sorts whole households by name, each kept in the order it was given", () => {
    // Bo brought Sam, so the API put Sam straight after Bo. A surname sort
    // inside the household would put Lee before Young and part them.
    const rows = rowsOf(
      invited("g1", "Bo", "Young", "Jones", "JONES-2"),
      invited("g2", "Sam", "Lee", "Jones", "JONES-2"),
      invited("g3", "Zoe", "Adams", "Adams", "ADAMS-1"),
      invited("g4", "Al", "Jones", "Jones", "JONES-1"),
    );
    // Two households both called Jones stay apart, by their codes.
    expect(ids(sortRows(rows, householdAsc))).toEqual(["g3", "g4", "g1", "g2"]);
    expect(ids(sortRows(rows, householdDesc))).toEqual(["g1", "g2", "g4", "g3"]);
  });

  it("keeps a household's replies before its guests still to answer", () => {
    // The API orders the replies and the silent guests as two lists, each by
    // household with every plus-one after the guest who brought them, and the
    // merge puts the replies first. Inside a household the sort keeps that, so
    // a plus-one whose reply a host recorded comes before the silent guest
    // who brought them.
    const rows = mergeRows({
      guests: [
        {
          guestId: "p1",
          firstName: "Sam",
          lastName: "Lee",
          familyName: "Jones",
          familyCode: "JONES-1",
          plusOneOf: "g1",
          plusOneOfName: "Bo Jones",
          status: "attending",
          dietary: "",
          dietaryPresets: [],
          consentSource: "organiser_attested",
        },
      ],
      unresponded: [
        {
          guestId: "g2",
          firstName: "Zoe",
          lastName: "Adams",
          familyName: "Adams",
          familyCode: "ADAMS-1",
        },
        {
          guestId: "g1",
          firstName: "Bo",
          lastName: "Jones",
          familyName: "Jones",
          familyCode: "JONES-1",
        },
      ],
    });
    expect(ids(sortRows(rows, householdAsc))).toEqual(["g2", "p1", "g1"]);
  });

  it("puts a household with no name last, in both directions", () => {
    const rows = rowsOf(
      invited("g1", "Ada", "Young", "", "NONE-1"),
      invited("g2", "Zoe", "Adams", "Adams"),
      invited("g3", "Kai", "Park", "Park"),
    );
    expect(ids(sortRows(rows, householdAsc))).toEqual(["g2", "g3", "g1"]);
    expect(ids(sortRows(rows, householdDesc))).toEqual(["g3", "g2", "g1"]);
  });

  it("leaves the rows it was given untouched", () => {
    const rows = rowsOf(invited("g1", "Ada", "Young"), invited("g2", "Zoe", "Adams"));
    const before = [...rows];
    sortRows(rows, guestAsc);
    expect(rows).toEqual(before);
  });

  it("returns the API's order when nothing is sorted", () => {
    const rows = rowsOf(invited("g1", "Ada", "Young"), invited("g2", "Zoe", "Adams"));
    expect(ids(sortRows(rows, null))).toEqual(["g1", "g2"]);
  });
});

describe("nextSort", () => {
  it("sorts a new column ascending, and reverses the column already sorted", () => {
    expect(nextSort(null, "guest")).toEqual({ key: "guest", direction: "ascending" });
    expect(nextSort({ key: "guest", direction: "ascending" }, "guest")).toEqual({
      key: "guest",
      direction: "descending",
    });
    expect(nextSort({ key: "guest", direction: "descending" }, "guest")).toEqual({
      key: "guest",
      direction: "ascending",
    });
    expect(nextSort({ key: "guest", direction: "descending" }, "household")).toEqual({
      key: "household",
      direction: "ascending",
    });
  });
});
