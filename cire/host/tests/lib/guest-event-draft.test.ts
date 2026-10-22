import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EventRow } from "../../src/lib/events-store";
import {
  createGuestEventDraft,
  type DesiredStateWire,
  type DraftEvent,
  type DraftFamily,
  type DraftGuest,
  type DraftState,
  draftWarnings,
  replayDraft,
  runOfShowItem,
  toDesiredState,
  validateDraft,
} from "../../src/lib/guest-event-draft";
import type { OrganiserGuestRow } from "../../src/lib/guests-store";

/**
 * The guest+event draft store (E5) — the client-side reconcile-input builder.
 * These pin the behaviours the DOM tests can't cheaply reach: id-stable rows
 * (rename ⇒ UPDATE not remove+create), dirty tracking against the loaded
 * baseline, in-session undo/discard, the attendance matrix, and the draft →
 * DesiredState serialisation both front doors funnel through.
 */

const EVENTS: EventRow[] = [
  {
    id: "evt_1",
    name: "Ceremony",
    slug: "ceremony",
    sortOrder: 0,
    startAt: "2026-11-14T15:00+11:00",
    endAt: "",
    timezone: "Australia/Sydney",
    address: "St Mary's",
    description: "",
    dressCodeDescription: null,
    dressCodePalette: null,
    pinterestUrl: null,
    mapsUrl: null,
    imageUrl: null,
    imageCrop: null,
  },
  {
    id: "evt_2",
    name: "Reception",
    slug: "reception",
    sortOrder: 1,
    startAt: "2026-11-14T18:00+11:00",
    endAt: "",
    timezone: "Australia/Sydney",
    address: "The Grounds",
    description: "",
    dressCodeDescription: null,
    dressCodePalette: null,
    pinterestUrl: null,
    mapsUrl: null,
    imageUrl: null,
    imageCrop: null,
  },
];

const GUESTS: OrganiserGuestRow[] = [
  {
    guestId: "g_1",
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    firstName: "Ada",
    lastName: "Sharma",
    nickname: null,
    events: ["evt_1", "evt_2"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
  {
    guestId: "g_2",
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    firstName: "Ben",
    lastName: "Sharma",
    nickname: "Benny",
    events: ["evt_1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

const REVISION = "rev_loaded";

function loaded() {
  const store = createGuestEventDraft();
  store.load(EVENTS, GUESTS, [], REVISION);
  return store;
}

describe("createGuestEventDraft — load + dirty", () => {
  it("groups flat guest rows into households and is not dirty at rest", () => {
    createRoot((dispose) => {
      const store = loaded();
      expect(store.loaded()).toBe(true);
      expect(store.draft.families).toHaveLength(1);
      expect(store.draft.families[0]!.guests).toHaveLength(2);
      expect(store.draft.families[0]!.publicId).toBe("SHARMA-KITE-77Q2");
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });

  it("resolves attendance ids to event keys (matrix state)", () => {
    createRoot((dispose) => {
      const store = loaded();
      const [ada, ben] = store.draft.families[0]!.guests;
      // Ada: both events; Ben: ceremony only.
      expect(ada!.eventKeys).toHaveLength(2);
      expect(ben!.eventKeys).toHaveLength(1);
      dispose();
    });
  });

  it("becomes dirty after an edit and clean again after commit", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.updateGuest(store.draft.families[0]!.guests[0]!.key, { firstName: "Adaeze" });
      expect(store.dirty()).toBe(true);
      store.commit();
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });

  it("keeps the change head it was loaded at, and a reload replaces it", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      expect(store.baseRevision()).toBeNull();
      store.load(EVENTS, GUESTS, [], "rev_1");
      expect(store.baseRevision()).toBe("rev_1");
      store.load(EVENTS, GUESTS, [], "rev_2");
      expect(store.baseRevision()).toBe("rev_2");
      dispose();
    });
  });
});

describe("createGuestEventDraft — reset", () => {
  it("drops a dirty draft entirely: nothing loaded, nothing to save, no revision", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.addFamily();
      store.updateGuest(store.draft.families[0]!.guests[0]!.key, { firstName: "Adaeze" });
      expect(store.dirty()).toBe(true);

      store.reset();

      expect(store.loaded()).toBe(false);
      expect(store.dirty()).toBe(false);
      expect(store.canUndo()).toBe(false);
      expect(store.baseRevision()).toBeNull();
      expect(store.draft.families).toHaveLength(0);
      expect(store.draft.events).toHaveLength(0);
      expect(store.errors()).toEqual([]);
      dispose();
    });
  });

  it("can be loaded again afterwards", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.reset();
      store.load(EVENTS, GUESTS, [], "rev_after");
      expect(store.loaded()).toBe(true);
      expect(store.dirty()).toBe(false);
      expect(store.draft.families[0]!.guests).toHaveLength(2);
      expect(store.baseRevision()).toBe("rev_after");
      dispose();
    });
  });
});

describe("createGuestEventDraft — id-stable rows", () => {
  it("a rename keeps the guest id so it serialises as an UPDATE not create", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.families[0]!.guests[0]!.key;
      store.updateGuest(key, { firstName: "Adaeze" });
      const wire = store.toWire();
      const g = wire.families[0]!.guests.find((x) => x.firstName === "Adaeze")!;
      expect(g.id).toBe("g_1"); // id preserved ⇒ diff treats as update
      dispose();
    });
  });

  it("a renamed household keeps its id and publicId (no code re-mint)", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.renameFamily(store.draft.families[0]!.key, "Sharma-Patel");
      const wire = store.toWire();
      expect(wire.families[0]!.id).toBe("fam_a");
      expect(wire.families[0]!.publicId).toBe("SHARMA-KITE-77Q2");
      expect(wire.families[0]!.familyName).toBe("Sharma-Patel");
      dispose();
    });
  });

  it("a new household/guest omits id (server mints) and household omits publicId", () => {
    createRoot((dispose) => {
      const store = loaded();
      const famKey = store.addFamily();
      store.renameFamily(famKey, "Nguyen");
      const gKey = store.addGuest(famKey);
      store.updateGuest(gKey, { firstName: "Linh" });
      const wire = store.toWire();
      const fam = wire.families.find((f) => f.familyName === "Nguyen")!;
      expect(fam.id).toBeUndefined();
      expect(fam.publicId).toBeUndefined(); // reconcile auto-mints the code
      expect(fam.guests[0]!.id).toBeUndefined();
      dispose();
    });
  });
});

describe("createGuestEventDraft — attendance matrix", () => {
  it("toggling a cell adds then removes the event from the serialised attendance", () => {
    createRoot((dispose) => {
      const store = loaded();
      const ben = store.draft.families[0]!.guests[1]!;
      const receptionKey = store.draft.events.find((e) => e.name === "Reception")!.key;
      // Ben starts NOT invited to Reception.
      expect(ben.eventKeys.includes(receptionKey)).toBe(false);
      store.toggleAttendance(ben.key, receptionKey);
      expect(toDesiredState(store.draft).families[0]!.guests[1]!.eventNames).toContain("Reception");
      store.toggleAttendance(ben.key, receptionKey);
      expect(toDesiredState(store.draft).families[0]!.guests[1]!.eventNames).not.toContain(
        "Reception",
      );
      dispose();
    });
  });
});

describe("createGuestEventDraft — undo + discard", () => {
  it("undo reverts the last mutation", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.families[0]!.guests[0]!.key;
      store.updateGuest(key, { firstName: "Zed" });
      expect(store.canUndo()).toBe(true);
      store.undo();
      expect(store.draft.families[0]!.guests[0]!.firstName).toBe("Ada");
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });

  it("discard rewinds every edit back to the loaded baseline", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.addFamily();
      store.updateGuest(store.draft.families[0]!.guests[0]!.key, { firstName: "X" });
      store.removeGuest(store.draft.families[0]!.guests[1]!.key);
      expect(store.dirty()).toBe(true);
      store.discard();
      expect(store.dirty()).toBe(false);
      expect(store.draft.families).toHaveLength(1);
      expect(store.draft.families[0]!.guests).toHaveLength(2);
      expect(store.draft.families[0]!.guests[0]!.firstName).toBe("Ada");
      dispose();
    });
  });
});

describe("createGuestEventDraft — serialisation preserves nickname", () => {
  it("an untouched guest round-trips its nickname (no blanking)", () => {
    createRoot((dispose) => {
      const store = loaded();
      const wire: DesiredStateWire = store.toWire();
      const ben = wire.families[0]!.guests.find((g) => g.firstName === "Ben")!;
      expect(ben.nickname).toBe("Benny");
      dispose();
    });
  });

  it("carries all events through unchanged so a guests-only save preserves the schedule", () => {
    createRoot((dispose) => {
      const store = loaded();
      const wire = store.toWire();
      expect(wire.events.map((e) => e.name).toSorted()).toEqual(["Ceremony", "Reception"]);
      // Existing events keep their id ⇒ id-matched update, never remove+create.
      expect(wire.events.every((e) => typeof e.id === "string")).toBe(true);
      dispose();
    });
  });
});

describe("validateDraft — client mirror of the server field rules", () => {
  it("flags a blank household name and a blank first name", () => {
    createRoot((dispose) => {
      const store = loaded();
      const famKey = store.addFamily(); // blank name
      store.addGuest(famKey); // blank first name
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("Household name is required"))).toBe(true);
      expect(errors.some((e) => e.message.includes("First name is required"))).toBe(true);
      dispose();
    });
  });

  it("flags two guests in one household sharing a first name (case-insensitive)", () => {
    createRoot((dispose) => {
      const store = loaded();
      // Rename Ben → 'ada' (matches Ada, case-folded) within the same household.
      store.updateGuest(store.draft.families[0]!.guests[1]!.key, { firstName: "ada" });
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("share a first name"))).toBe(true);
      dispose();
    });
  });

  it("a valid draft has no errors", () => {
    createRoot((dispose) => {
      const store = loaded();
      expect(validateDraft(store.draft)).toHaveLength(0);
      dispose();
    });
  });
});

// ── event editing on the shared draft ─────────────────────────────────────

describe("createGuestEventDraft — event editing (E6)", () => {
  it("edits an existing event id-stably (rename ⇒ UPDATE, keeps id)", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events.find((e) => e.name === "Ceremony")!.key;
      store.updateEvent(key, { name: "Wedding Ceremony", address: "St Andrew's" });
      const wire = store.toWire();
      const evt = wire.events.find((e) => e.name === "Wedding Ceremony")!;
      expect(evt.id).toBe("evt_1"); // preserved ⇒ id-matched update, no remove+create
      expect(evt.address).toBe("St Andrew's");
      dispose();
    });
  });

  it("adds a new event with no id (server mints) at the end of the schedule", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      store.updateEvent(key, {
        name: "Brunch",
        startAt: "2026-11-15T10:00:00+11:00",
        timezone: "Australia/Sydney",
      });
      const wire = store.toWire();
      const brunch = wire.events.find((e) => e.name === "Brunch")!;
      expect(brunch.id).toBeUndefined();
      expect(brunch.sortOrder).toBe(2); // after Ceremony(0) + Reception(1)
      dispose();
    });
  });

  it("removes an event and strips its attendance from every guest", () => {
    createRoot((dispose) => {
      const store = loaded();
      const receptionKey = store.draft.events.find((e) => e.name === "Reception")!.key;
      store.removeEvent(receptionKey);
      const wire = store.toWire();
      expect(wire.events.some((e) => e.name === "Reception")).toBe(false);
      // No guest should still reference the removed event by name.
      const stillInvited = wire.families
        .flatMap((f) => f.guests)
        .some((g) => g.eventNames.includes("Reception"));
      expect(stillInvited).toBe(false);
      dispose();
    });
  });

  it("reorders events and rewrites sortOrder to the new index", () => {
    createRoot((dispose) => {
      const store = loaded();
      // Ceremony(0), Reception(1) → drag Reception to the top.
      store.reorderEvents(1, 0);
      const wire = store.toWire();
      const reception = wire.events.find((e) => e.name === "Reception")!;
      const ceremony = wire.events.find((e) => e.name === "Ceremony")!;
      expect(reception.sortOrder).toBe(0);
      expect(ceremony.sortOrder).toBe(1);
      expect(store.draft.events.map((e) => e.name)).toEqual(["Reception", "Ceremony"]);
      dispose();
    });
  });

  it("splices rather than swaps when moving across the middle of the list", () => {
    createRoot((dispose) => {
      const store = loaded();
      // A 2-element list can't tell a splice from a swap, so add a third.
      const key = store.addEvent();
      store.updateEvent(key, {
        name: "Brunch",
        startAt: "2026-11-15T10:00:00+11:00",
        timezone: "Australia/Sydney",
      });
      expect(store.draft.events.map((e) => e.name)).toEqual(["Ceremony", "Reception", "Brunch"]);

      store.reorderEvents(0, 2);

      // Splice: Ceremony lands LAST and the others close up. A swap would have
      // produced ["Brunch", "Reception", "Ceremony"].
      expect(store.draft.events.map((e) => e.name)).toEqual(["Reception", "Brunch", "Ceremony"]);
      expect(store.toWire().events.map((e) => [e.name, e.sortOrder])).toEqual([
        ["Reception", 0],
        ["Brunch", 1],
        ["Ceremony", 2],
      ]);
      dispose();
    });
  });

  it("undo reverts a reorder including its sortOrder renumbering", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.reorderEvents(1, 0);
      expect(store.draft.events.map((e) => e.name)).toEqual(["Reception", "Ceremony"]);

      store.undo();

      // reorderEvents is the only mutation that both checkpoints AND renumbers;
      // a misordered checkpoint would restore the order but not the sortOrder.
      expect(store.draft.events.map((e) => e.name)).toEqual(["Ceremony", "Reception"]);
      expect(store.toWire().events.map((e) => [e.name, e.sortOrder])).toEqual([
        ["Ceremony", 0],
        ["Reception", 1],
      ]);
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });

  it("ignores a reorder that is a no-op or out of bounds", () => {
    createRoot((dispose) => {
      const store = loaded();
      const before = store.draft.events.map((e) => e.name);
      store.reorderEvents(0, 0);
      store.reorderEvents(0, 5);
      store.reorderEvents(-1, 1);
      expect(store.draft.events.map((e) => e.name)).toEqual(before);
      // No checkpoint was recorded, so the draft is untouched.
      expect(store.dirty()).toBe(false);
      expect(store.canUndo()).toBe(false);
      dispose();
    });
  });

  it("undo reverts an event edit", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events.find((e) => e.name === "Ceremony")!.key;
      store.updateEvent(key, { name: "Renamed" });
      expect(store.dirty()).toBe(true);
      store.undo();
      expect(store.draft.events.find((e) => e.id === "evt_1")!.name).toBe("Ceremony");
      dispose();
    });
  });
});

describe("an event's description and venue name", () => {
  // The server refuses either over its cell cap (`MAX_CELL_LENGTH`); the
  // drawer says so before the save does.
  it("flags a description or venue name longer than the server takes", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, { description: "x".repeat(10_001), venueName: "y".repeat(10_001) });
      const messages = validateDraft(store.draft).map((e) => e.message);
      expect(messages).toContain("Description is too long.");
      expect(messages).toContain("Venue name is too long.");

      store.updateEvent(key, { description: "x".repeat(10_000), venueName: "y".repeat(10_000) });
      expect(validateDraft(store.draft)).toEqual([]);
      dispose();
    });
  });

  it("starts a new event with no description and no venue name", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      expect(store.draft.events.find((e) => e.key === key)).toMatchObject({
        description: "",
        venueName: null,
      });
      dispose();
    });
  });

  // `location` stays on the wire, null, because an API older than the venue
  // name requires the key; the current API ignores it.
  it("sends both on the wire, with location null", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, { description: "Mass at 3.\nDrinks after.", venueName: "St Mary's" });
      const [ceremony, reception] = toDesiredState(store.draft).events;
      expect(ceremony).toMatchObject({
        description: "Mass at 3.\nDrinks after.",
        venueName: "St Mary's",
        location: null,
      });
      expect(reception).toMatchObject({ description: "", venueName: null, location: null });
      dispose();
    });
  });

  // The guests editor's save governs no event: its events are there only so
  // the attendance can name them, and an absent field leaves what is stored.
  it("leaves both out of a guests save", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, { description: "Mass at 3.", venueName: "St Mary's" });
      for (const event of store.toWire("guests").events) {
        expect(event).not.toHaveProperty("description");
        expect(event).not.toHaveProperty("venueName");
        expect(event).toHaveProperty("location", null);
      }
      expect(store.toWire("events").events[0]).toMatchObject({
        description: "Mass at 3.",
        venueName: "St Mary's",
      });
      dispose();
    });
  });

  // The server holds every value the editor stores to its cell cap.
  it("flags a Pinterest link, maps link or swatch name longer than the server takes", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      const long = (n: number) => `https://example.test/${"a".repeat(n - 21)}`;
      store.updateEvent(key, {
        pinterestUrl: long(10_001),
        mapsUrl: long(10_001),
        dressCodePalette: [{ name: "n".repeat(10_001), color: "#1f6f50" }],
      });
      const messages = validateDraft(store.draft).map((e) => e.message);
      expect(messages).toContain("Pinterest link is too long.");
      expect(messages).toContain("Maps link is too long.");
      expect(messages).toContain("A palette swatch name is too long.");

      store.updateEvent(key, {
        pinterestUrl: long(10_000),
        mapsUrl: long(10_000),
        dressCodePalette: [{ name: "n".repeat(10_000), color: "#1f6f50" }],
      });
      expect(validateDraft(store.draft)).toEqual([]);
      dispose();
    });
  });

  it("keeps an unsaved description and venue name across a stale reload", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, { description: "Mass at 3.", venueName: "St Mary's" });
      store.rebase(
        EVENTS.map((e) => (e.id === "evt_1" ? { ...e, name: "Wedding Ceremony" } : e)),
        GUESTS,
        [],
        "rev-2",
      );
      expect(store.draft.events[0]).toMatchObject({
        name: "Wedding Ceremony",
        description: "Mass at 3.",
        venueName: "St Mary's",
      });
      expect(store.dirty()).toBe(true);
      dispose();
    });
  });
});

describe("an event's run of show, getting-there notes and guest policy", () => {
  const FULL: EventRow = {
    ...EVENTS[0]!,
    runOfShow: [
      { time: "17:15", label: "Speeches" },
      { time: "15:00", label: "Vows" },
    ],
    gettingThere: "Park on Sample Lane.",
    childrenPolicy: "adults_only",
    plusOnePolicy: "welcome",
    guestPolicyNote: "Hats encouraged.",
  };
  const items = (event: DraftEvent) => event.runOfShow.map(({ time, label }) => ({ time, label }));
  /** The events as a current API reads them: every event carries the keys. */
  const CURRENT: EventRow[] = EVENTS.map((e) => ({
    runOfShow: [],
    gettingThere: null,
    childrenPolicy: null,
    plusOnePolicy: null,
    guestPolicyNote: null,
    ...e,
  }));
  const loadedCurrent = () => {
    const store = createGuestEventDraft();
    store.load(CURRENT, GUESTS, [], REVISION);
    return store;
  };

  // What the events read sends is what the drawer opens on; an API older
  // than these fields sends none, which is none of each.
  it("loads them from the events read, and an API that sends none as empty", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      store.load([FULL, EVENTS[1]!], GUESTS, [], REVISION);
      const [ceremony, reception] = store.draft.events;
      expect(items(ceremony!)).toEqual(FULL.runOfShow);
      expect(ceremony).toMatchObject({
        gettingThere: "Park on Sample Lane.",
        childrenPolicy: "adults_only",
        plusOnePolicy: "welcome",
        guestPolicyNote: "Hats encouraged.",
      });
      expect(reception).toMatchObject({
        runOfShow: [],
        gettingThere: null,
        childrenPolicy: null,
        plusOnePolicy: null,
        guestPolicyNote: null,
      });
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });

  // An events save states all of them, in the organiser's order, trimmed, so
  // a download of what is stored re-imports unchanged; blank notes are none.
  // A guests save governs no event and leaves them out.
  it("sends them on an events save and leaves them out of a guests save", () => {
    createRoot((dispose) => {
      const store = loadedCurrent();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, {
        runOfShow: [runOfShowItem("16:45", "  Garden games "), runOfShowItem("16:00", "Tea")],
        gettingThere: "  Park on Sample Lane.\n",
        childrenPolicy: "children_welcome",
        plusOnePolicy: "by_invitation",
        guestPolicyNote: "   ",
      });
      expect(store.toWire("events").events[0]).toMatchObject({
        runOfShow: [
          { time: "16:45", label: "Garden games" },
          { time: "16:00", label: "Tea" },
        ],
        gettingThere: "Park on Sample Lane.",
        childrenPolicy: "children_welcome",
        plusOnePolicy: "by_invitation",
        guestPolicyNote: null,
      });
      expect(store.toWire("events").events[1]).toMatchObject({
        runOfShow: [],
        gettingThere: null,
        childrenPolicy: null,
        plusOnePolicy: null,
        guestPolicyNote: null,
      });
      for (const event of store.toWire("guests").events) {
        for (const field of [
          "runOfShow",
          "gettingThere",
          "childrenPolicy",
          "plusOnePolicy",
          "guestPolicyNote",
        ]) {
          expect(event).not.toHaveProperty(field);
        }
      }
      expect(store.dirty()).toBe(true);
      dispose();
    });
  });

  // An API older than the fields sends none of them on any event, and would
  // drop them from a save unstored: the draft says so, and the events save
  // leaves them out. With no events there is nothing to tell by.
  it("leaves them out of a save to an API whose events read carries none of them", () => {
    createRoot((dispose) => {
      // Nothing loaded, or the draft dropped: no API has said otherwise yet.
      const unloaded = createGuestEventDraft();
      expect(unloaded.eventDetails()).toBe(true);
      const store = loaded();
      expect(store.eventDetails()).toBe(false);
      store.reset();
      expect(store.eventDetails()).toBe(true);
      store.load(EVENTS, GUESTS, [], REVISION);
      store.updateEvent(store.draft.events[0]!.key, { description: "Mass at 3." });
      const [event] = store.toWire("events").events;
      expect(event).toMatchObject({ description: "Mass at 3." });
      for (const field of [
        "runOfShow",
        "gettingThere",
        "childrenPolicy",
        "plusOnePolicy",
        "guestPolicyNote",
      ]) {
        expect(event).not.toHaveProperty(field);
      }
      expect(loadedCurrent().eventDetails()).toBe(true);
      const empty = createGuestEventDraft();
      empty.load([], GUESTS, [], REVISION);
      expect(empty.eventDetails()).toBe(true);
      // A reload against the older API says so too.
      const current = loadedCurrent();
      current.rebase(EVENTS, GUESTS, [], "rev-2");
      expect(current.eventDetails()).toBe(false);
      dispose();
    });
  });

  // The drawer says what the server would refuse, before the save does.
  it("flags a run of show or notes the server would refuse", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      const messagesFor = (patch: Parameters<typeof store.updateEvent>[1]) => {
        store.updateEvent(key, patch);
        return validateDraft(store.draft).map((e) => e.message);
      };
      // An item's own errors name it by its number and say which field, so
      // the drawer shows each under that item's field.
      const named = runOfShowItem("16:00", "Tea");
      const blank = runOfShowItem("", "  ");
      store.updateEvent(key, { runOfShow: [named, blank] });
      expect(validateDraft(store.draft)).toEqual([
        { key, item: blank.key, field: "time", message: "Item 2 needs a time." },
        { key, item: blank.key, field: "label", message: "Item 2 needs a name." },
      ]);
      // "Add item" opens an empty row.
      expect(runOfShowItem()).toMatchObject({ time: "", label: "" });
      const long = runOfShowItem("16:00", "x".repeat(201));
      store.updateEvent(key, { runOfShow: [long] });
      expect(validateDraft(store.draft)).toEqual([
        {
          key,
          item: long.key,
          field: "label",
          message: "Item 1 is longer than 200 characters.",
        },
      ]);
      expect(
        messagesFor({ runOfShow: Array.from({ length: 41 }, () => runOfShowItem("16:00", "Tea")) }),
      ).toContain("A run of show holds at most 40 items.");
      expect(messagesFor({ runOfShow: [], gettingThere: "x".repeat(10_001) })).toContain(
        "Getting-there notes are too long.",
      );
      expect(messagesFor({ gettingThere: null, guestPolicyNote: "x".repeat(10_001) })).toContain(
        "The guest policy note is too long.",
      );
      // At the cap, measured after the trim the save applies.
      store.updateEvent(key, {
        runOfShow: Array.from({ length: 40 }, () => runOfShowItem("23:59", ` ${"x".repeat(200)} `)),
        gettingThere: `${"x".repeat(10_000)}\n`,
        guestPolicyNote: ` ${"x".repeat(10_000)}`,
      });
      expect(validateDraft(store.draft)).toEqual([]);
      dispose();
    });
  });

  // Someone else's change landed; the organiser's unsaved run of show, policy
  // and notes go back on top, and what they did not touch takes the new rows.
  it("keeps unsaved changes to them across a stale reload, and takes fresh ones it did not touch", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      store.load([FULL, EVENTS[1]!], GUESTS, [], REVISION);
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, {
        runOfShow: [runOfShowItem("15:00", "Vows"), runOfShowItem("17:15", "Speeches")],
        childrenPolicy: "children_welcome",
      });
      store.rebase(
        [{ ...FULL, gettingThere: "Park behind the hall.", plusOnePolicy: null }, EVENTS[1]!],
        GUESTS,
        [],
        "rev-2",
      );
      const [ceremony] = store.draft.events;
      expect(items(ceremony!)).toEqual([
        { time: "15:00", label: "Vows" },
        { time: "17:15", label: "Speeches" },
      ]);
      expect(ceremony).toMatchObject({
        childrenPolicy: "children_welcome",
        gettingThere: "Park behind the hall.",
        plusOnePolicy: null,
      });
      expect(store.dirty()).toBe(true);
      dispose();
    });
  });

  // Removing an item and adding it back as it was ends where it started, so
  // it is no edit, and someone else's change to the list stands.
  it("takes the fresh run of show over one the organiser put back as it was", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      store.load([FULL, EVENTS[1]!], GUESTS, [], REVISION);
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, {
        runOfShow: [runOfShowItem("17:15", "Speeches"), runOfShowItem("15:00", "Vows")],
      });
      store.rebase(
        [{ ...FULL, runOfShow: [{ time: "16:00", label: "Tea" }] }, EVENTS[1]!],
        GUESTS,
        [],
        "rev-2",
      );
      expect(items(store.draft.events[0]!)).toEqual([{ time: "16:00", label: "Tea" }]);
      dispose();
    });
  });

  // The drawer's rows follow their items: an item moved or edited is the same
  // item in the store, so its row and the input being typed in stay.
  it("keeps each item's identity when the list is reordered or edited", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      store.load([FULL, EVENTS[1]!], GUESTS, [], REVISION);
      const key = store.draft.events[0]!.key;
      const [speeches, vows] = store.draft.events[0]!.runOfShow;
      store.updateEvent(key, {
        runOfShow: [{ ...vows! }, { ...speeches!, label: "Speeches and toasts" }],
      });
      const [first, second] = store.draft.events[0]!.runOfShow;
      expect(first).toBe(vows);
      expect(second).toBe(speeches);
      expect(second!.label).toBe("Speeches and toasts");
      dispose();
    });
  });
});

describe("validateDraft — event field rules (E6)", () => {
  it("flags a blank name + start on a new event", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.addEvent(); // all-blank except the seeded zone
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("Event name is required"))).toBe(true);
      expect(errors.some((e) => e.message.includes("Start date & time is required"))).toBe(true);
      dispose();
    });
  });

  it("seeds a new event with the organiser's own zone, so it isn't a blank required field", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      expect(store.draft.events.find((e) => e.key === key)!.timezone).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      expect(
        validateDraft(store.draft).some((e) => e.message.includes("Timezone is required")),
      ).toBe(false);
      dispose();
    });
  });

  it("still flags a zone cleared by hand", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      store.updateEvent(key, { timezone: "" });
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("Timezone is required"))).toBe(true);
      dispose();
    });
  });

  it("names the missing half of a half-filled Start/End, rather than calling it malformed", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      // What the drawer writes when a day is picked but no time typed yet.
      store.updateEvent(key, { name: "Party", startAt: "2026-11-14", endAt: "2026-11-15" });
      const errors = validateDraft(store.draft).map((e) => e.message);
      expect(errors).toContain("Start time is required.");
      expect(errors).toContain("End time is required.");
      // Named, not merely rejected: the generic "not a valid date, time &
      // timezone offset" is true but doesn't say which half is missing.
      expect(errors).not.toContain("Start must be a valid date, time & timezone offset.");
      // (That these BLOCK the save is pinned where it is observable — the
      // disabled Save button in `EventsEditor.test.tsx`. Asserting a non-empty
      // array here could not fail, given the two `toContain`s above it.)
      dispose();
    });
  });

  it("flags a non-ISO start and a non-http(s) URL", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      store.updateEvent(key, {
        name: "Party",
        startAt: "next tuesday",
        timezone: "Australia/Sydney",
        pinterestUrl: "javascript:alert(1)",
      });
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("Start must be a valid"))).toBe(true);
      expect(errors.some((e) => e.message.includes("Pinterest link must be an http(s) URL"))).toBe(
        true,
      );
      dispose();
    });
  });

  it("rejects a duplicate event name (case/space-insensitive)", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.addEvent();
      store.updateEvent(key, {
        name: "  ceremony ",
        startAt: "2026-11-14T15:00:00+11:00",
        timezone: "Australia/Sydney",
      });
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("Another event already has this name"))).toBe(
        true,
      );
      dispose();
    });
  });

  it("rejects a palette swatch with an un-allowed colour value", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, {
        dressCodePalette: [{ name: "Bad", color: "url(javascript:alert(1))" }],
      });
      const errors = validateDraft(store.draft);
      expect(errors.some((e) => e.message.includes("allowed colour value"))).toBe(true);
      dispose();
    });
  });

  it("warns (not errors) when end is before start", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.events[0]!.key;
      store.updateEvent(key, {
        startAt: "2026-11-14T18:00:00+11:00",
        endAt: "2026-11-14T15:00:00+11:00",
      });
      // Not a blocking error…
      expect(validateDraft(store.draft).some((e) => e.message.includes("ends before"))).toBe(false);
      // …but a warning.
      expect(draftWarnings(store.draft).some((w) => w.includes("ends before it starts"))).toBe(
        true,
      );
      dispose();
    });
  });
});

describe("createGuestEventDraft — deletions reach the wire", () => {
  it("a removed guest is gone from the draft AND from the DesiredState", () => {
    createRoot((dispose) => {
      const store = loaded();
      const ben = store.draft.families[0]!.guests[1]!;
      store.removeGuest(ben.key);
      expect(store.draft.families[0]!.guests.map((g) => g.firstName)).toEqual(["Ada"]);
      // The wire is what the server diffs — a deletion is expressed by absence,
      // so a row that survives serialisation is a deletion that never happens.
      expect(store.toWire().families[0]!.guests.map((g) => g.id)).toEqual(["g_1"]);
      expect(store.dirty()).toBe(true);
      dispose();
    });
  });

  it("a removed household is gone from the DesiredState", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.removeFamily(store.draft.families[0]!.key);
      expect(store.toWire().families).toHaveLength(0);
      expect(store.dirty()).toBe(true);
      dispose();
    });
  });
});

describe("createGuestEventDraft — discard after a save", () => {
  /** `commit()` adopts the saved draft as the new baseline. If it ever stopped
   *  doing so, "discard" after a successful save would rewind to the PRE-save
   *  state — resurrecting every row the organiser just deleted, in the UI, with
   *  `dirty()` reporting false. Same silent resurrection this store exists to
   *  prevent, one layer up, and the fingerprint-only dirty check can't see it. */
  it("discards back to the COMMITTED state, not the loaded one", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.removeGuest(store.draft.families[0]!.guests[1]!.key);
      store.commit(); // as handleApply does after a successful save
      expect(store.dirty()).toBe(false);

      store.addGuest(store.draft.families[0]!.key);
      expect(store.dirty()).toBe(true);
      store.discard();

      // Back to one guest — the save stands, the post-save edit is gone.
      expect(store.draft.families[0]!.guests.map((g) => g.firstName)).toEqual(["Ada"]);
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });
});

describe("createGuestEventDraft — guest-less households", () => {
  /** A household holding no guests can't be described by the guest rows, so the
   *  editor loads it separately. Dropping it from the draft would read as a
   *  deletion on the next save and take its claim code with it. */
  const EMPTY_HOUSEHOLD = {
    familyId: "fam_empty",
    publicId: "EMPTY-CODE-0001",
    familyName: "Code Only",
    guestCount: 0,
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  };

  function loadedWithEmpty() {
    const store = createGuestEventDraft();
    store.load(
      EVENTS,
      GUESTS,
      [
        {
          familyId: "fam_a",
          publicId: "SHARMA-KITE-77Q2",
          familyName: "Sharma",
          guestCount: 2,
          codeSharedAt: null,
          firstOpenedAt: null,
          deactivatedAt: null,
        },
        EMPTY_HOUSEHOLD,
      ],
      REVISION,
    );
    return store;
  }

  it("appears in the draft with its id + code, and round-trips clean", () => {
    createRoot((dispose) => {
      const store = loadedWithEmpty();
      const empty = store.draft.families.find((f) => f.id === "fam_empty");
      expect(empty).toBeDefined();
      expect(empty!.publicId).toBe("EMPTY-CODE-0001");
      expect(empty!.guests).toHaveLength(0);
      // Loading it is not an edit.
      expect(store.dirty()).toBe(false);
      // …and it survives serialisation, so the diff matches it by id instead of
      // reading its absence as a removal.
      const wire = store.toWire();
      expect(wire.families.map((f) => f.id)).toEqual(["fam_a", "fam_empty"]);
      dispose();
    });
  });

  it("keeps the populated households in their existing order", () => {
    createRoot((dispose) => {
      const store = loadedWithEmpty();
      expect(store.draft.families.map((f) => f.familyName)).toEqual(["Sharma", "Code Only"]);
      dispose();
    });
  });
});

describe("createGuestEventDraft — discard past the undo limit", () => {
  /** Every keystroke checkpoints, so a real editing session overflows the undo
   *  stack easily. Discard used to rewind to the OLDEST retained snapshot — a
   *  mid-edit state once the earliest ones had been evicted — and then declare
   *  the draft clean, silently keeping edits the organiser asked to throw away. */
  it("restores the loaded state, not the oldest surviving undo snapshot", () => {
    createRoot((dispose) => {
      const store = loaded();
      const key = store.draft.families[0]!.guests[0]!.key;
      // 150 mutations > UNDO_LIMIT (100), so the earliest snapshots are evicted.
      for (let i = 0; i < 150; i++) {
        store.updateGuest(key, { firstName: `Ada${i}` });
      }
      expect(store.dirty()).toBe(true);

      store.discard();

      expect(store.draft.families[0]!.guests[0]!.firstName).toBe("Ada");
      expect(store.draft.families[0]!.guests).toHaveLength(2);
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });
});

describe("createGuestEventDraft — plus-ones", () => {
  it("keeps every ordinary guest when the API sends plusOneOf: null, as it does for each", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      const asServed = GUESTS.map((g): OrganiserGuestRow =>
        Object.assign({}, g, { plusOneAllowed: false, plusOneOf: null }),
      );
      const plusOne: OrganiserGuestRow = Object.assign({}, GUESTS[0]!, {
        guestId: "g_plus",
        firstName: "Sam",
        plusOneAllowed: false,
        plusOneOf: "g_1",
      });
      store.load(EVENTS, [...asServed, plusOne], [], REVISION);
      expect(store.draft.families[0]!.guests.map((g) => g.id)).toEqual(["g_1", "g_2"]);
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });

  it("leaves a plus-one's row out of the draft and the wire", () => {
    createRoot((dispose) => {
      const store = createGuestEventDraft();
      const plusOne: OrganiserGuestRow = {
        ...GUESTS[0]!,
        guestId: "g_plus",
        firstName: "Sam",
        plusOneAllowed: false,
        plusOneOf: "g_1",
      };
      store.load(EVENTS, [GUESTS[0]!, plusOne, GUESTS[1]!], [], REVISION);
      expect(store.draft.families[0]!.guests.map((g) => g.id)).toEqual(["g_1", "g_2"]);
      const wire = store.toWire();
      expect(wire.families.flatMap((f) => f.guests.map((g) => g.id))).not.toContain("g_plus");
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });
});

// ── replayDraft ───────────────────────────────────────────────────────────────

describe("replayDraft — keeping unsaved edits across a reload", () => {
  function evt(key: string, id: string | null, name: string, sortOrder: number): DraftEvent {
    return {
      key,
      id,
      name,
      startAt: "2026-11-14T15:00:00+11:00",
      endAt: "",
      timezone: "Australia/Sydney",
      description: "",
      venueName: null,
      address: null,
      runOfShow: [],
      gettingThere: null,
      childrenPolicy: null,
      plusOnePolicy: null,
      guestPolicyNote: null,
      dressCodeDescription: null,
      dressCodePalette: [],
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder,
    };
  }
  function guest(key: string, id: string | null, firstName: string, eventKeys: string[] = []) {
    return { key, id, firstName, lastName: "", nickname: null, eventKeys } satisfies DraftGuest;
  }
  function fam(key: string, id: string | null, familyName: string, guests: DraftGuest[]) {
    return {
      key,
      id,
      publicId: id ? `${id}-CODE` : null,
      familyName,
      guests,
    } satisfies DraftFamily;
  }

  /** The loaded draft: events A, B; household Sharma with Ada (at A). */
  function baseline(): DraftState {
    return {
      events: [evt("e1", "evt_a", "A", 0), evt("e2", "evt_b", "B", 1)],
      families: [fam("f1", "fam_s", "Sharma", [guest("g1", "g_ada", "Ada", ["e1"])])],
    };
  }
  /** The same rows as the server now sends them, under fresh keys. */
  function freshOf(state: DraftState): DraftState {
    const keyOf = new Map(state.events.map((e) => [e.key, `x${e.key}`]));
    return {
      events: state.events.map((e) => ({ ...e, key: `x${e.key}` })),
      families: state.families.map((f) => ({
        ...f,
        key: `x${f.key}`,
        guests: f.guests.map((g) => ({
          ...g,
          key: `x${g.key}`,
          eventKeys: g.eventKeys.map((k) => keyOf.get(k)!),
        })),
      })),
    };
  }

  it("keeps the organiser's field edits and the other change's edits to other fields", () => {
    const base = baseline();
    const current = structuredClone(base);
    current.families[0]!.guests[0]!.firstName = "Adaeze";
    current.events[0]!.address = "St Mary's";
    const fresh = freshOf(base);
    fresh.families[0]!.guests[0]!.lastName = "Sharma";
    fresh.events[0]!.name = "A renamed";

    const { draft, notes } = replayDraft(base, current, fresh);
    expect(draft.families[0]!.guests[0]).toMatchObject({ firstName: "Adaeze", lastName: "Sharma" });
    expect(draft.events[0]).toMatchObject({ name: "A renamed", address: "St Mary's" });
    expect(notes).toEqual([]);
  });

  it("the organiser's value wins on a field both changed", () => {
    const base = baseline();
    const current = structuredClone(base);
    current.families[0]!.familyName = "Sharma-Patel";
    const fresh = freshOf(base);
    fresh.families[0]!.familyName = "Sharmas";
    expect(replayDraft(base, current, fresh).draft.families[0]!.familyName).toBe("Sharma-Patel");
  });

  it("replays removals and additions next to rows the other change added", () => {
    const base = baseline();
    base.families[0]!.guests.push(guest("g2", "g_ben", "Ben"));
    const current = structuredClone(base);
    current.families[0]!.guests.splice(1, 1); // remove Ben
    current.families[0]!.guests.push(guest("n1", null, "Cy"));
    current.families.push(fam("n2", null, "Nguyen", [guest("n3", null, "Di", ["e2"])]));
    const fresh = freshOf(base);
    fresh.families[0]!.guests.push(guest("xg9", "g_raj", "Raj"));

    const { draft } = replayDraft(base, current, fresh);
    expect(draft.families[0]!.guests.map((g) => [g.id, g.firstName])).toEqual([
      ["g_ada", "Ada"],
      ["g_raj", "Raj"],
      [null, "Cy"],
    ]);
    // The new household stays new, and its tick points at the reloaded B.
    expect(draft.families[1]).toMatchObject({ id: null, familyName: "Nguyen" });
    expect(draft.families[1]!.guests[0]!.eventKeys).toEqual(["xe2"]);
  });

  it("replays ticks and unticks, and keeps the other change's tick on the same guest", () => {
    const base = baseline();
    const current = structuredClone(base);
    current.families[0]!.guests[0]!.eventKeys = ["e2"]; // untick A, tick B
    const fresh = freshOf(base);
    fresh.events.push(evt("xe3", "evt_c", "C", 2));
    fresh.families[0]!.guests[0]!.eventKeys = ["xe1", "xe3"]; // co-host ticked C

    const { draft } = replayDraft(base, current, fresh);
    expect(draft.families[0]!.guests[0]!.eventKeys.toSorted()).toEqual(["xe2", "xe3"]);
  });

  it("names an edit to a row deleted elsewhere, and a tick on an event deleted elsewhere", () => {
    const base = baseline();
    base.families.push(fam("f2", "fam_p", "Patel", [guest("g3", "g_raj", "Raj")]));
    const current = structuredClone(base);
    current.families[1]!.familyName = "Patels";
    current.families[0]!.guests[0]!.eventKeys = ["e1", "e2"];
    current.events[0]!.address = "Somewhere";
    const fresh = freshOf(base);
    fresh.families.splice(1, 1); // Patel deleted elsewhere
    fresh.events.splice(1, 1); // B deleted elsewhere
    fresh.events.splice(0, 1); // A deleted elsewhere

    const { draft, notes } = replayDraft(base, current, fresh);
    expect(draft.families.map((f) => f.familyName)).toEqual(["Sharma"]);
    expect(draft.events).toEqual([]);
    expect(notes).toEqual([
      "“A” was deleted elsewhere, so your changes to it were not kept.",
      "“Ada” was invited to “B”, which was deleted elsewhere.",
      "“Patels” was removed elsewhere, so your changes to it were not kept.",
    ]);
  });

  it("flags a new household whose name was also added elsewhere as a possible duplicate", () => {
    const base = baseline();
    const current = structuredClone(base);
    current.families.push(fam("n1", null, "Nguyen", []));
    const fresh = freshOf(base);
    fresh.families.push(fam("xf9", "fam_n", "nguyen ", []));

    const { draft, notes } = replayDraft(base, current, fresh);
    // Kept — the organiser decides — but named.
    expect(draft.families).toHaveLength(3);
    expect(notes).toEqual([
      "A household called “Nguyen” was also added elsewhere — check for a duplicate.",
    ]);
  });

  it("says when a household the organiser removed has gained guests elsewhere", () => {
    const base = baseline();
    const current = structuredClone(base);
    current.families.splice(0, 1);
    const fresh = freshOf(base);
    fresh.families[0]!.guests.push(guest("xg9", "g_raj", "Raj"));

    const { draft, notes } = replayDraft(base, current, fresh);
    expect(draft.families).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/“Sharma” gained guests elsewhere/);
  });

  it("replays a reorder as the order of shared events, with events added elsewhere last", () => {
    const base = baseline();
    const current = structuredClone(base);
    current.events.reverse();
    current.events.forEach((e, i) => (e.sortOrder = i));
    const fresh = freshOf(base);
    fresh.events.push(evt("xe3", "evt_c", "C", 2));

    const { draft } = replayDraft(base, current, fresh);
    expect(draft.events.map((e) => [e.name, e.sortOrder])).toEqual([
      ["B", 0],
      ["A", 1],
      ["C", 2],
    ]);
  });

  it("keeps the fresh order when the organiser only removed an event", () => {
    const base: DraftState = {
      events: [evt("e1", "evt_a", "A", 0), evt("e2", "evt_b", "B", 1), evt("e3", "evt_c", "C", 2)],
      families: [],
    };
    const current = structuredClone(base);
    current.events.splice(0, 1); // remove A; B and C renumber to 0, 1
    current.events.forEach((e, i) => (e.sortOrder = i));
    const fresh = freshOf(base);
    // The other change swapped B and C.
    fresh.events = [fresh.events[0]!, fresh.events[2]!, fresh.events[1]!];

    const { draft } = replayDraft(base, current, fresh);
    expect(draft.events.map((e) => [e.name, e.sortOrder])).toEqual([
      ["C", 0],
      ["B", 1],
    ]);
  });
});

describe("createGuestEventDraft — rebase", () => {
  it("re-seeds on the new head with the edit kept, still dirty, with no undo into the old rows", () => {
    createRoot((dispose) => {
      const store = loaded();
      store.updateGuest(store.draft.families[0]!.guests[0]!.key, { firstName: "Adaeze" });
      expect(store.canUndo()).toBe(true);

      const raj = { ...GUESTS[1]!, guestId: "g_3", firstName: "Raj", nickname: null };
      const notes = store.rebase(EVENTS, [...GUESTS, raj], [], "rev_next");

      expect(notes).toEqual([]);
      expect(store.baseRevision()).toBe("rev_next");
      expect(store.canUndo()).toBe(false);
      expect(store.dirty()).toBe(true);
      expect(store.draft.families[0]!.guests.map((g) => g.firstName)).toEqual([
        "Adaeze",
        "Ben",
        "Raj",
      ]);
      // Discard goes back to the rows loaded at the new head, not the old ones.
      store.discard();
      expect(store.draft.families[0]!.guests.map((g) => g.firstName)).toEqual([
        "Ada",
        "Ben",
        "Raj",
      ]);
      expect(store.dirty()).toBe(false);
      dispose();
    });
  });
});

describe("replayDraft — edge branches", () => {
  function evt(key: string, id: string | null, name: string, sortOrder: number): DraftEvent {
    return {
      key,
      id,
      name,
      startAt: "2026-11-14T15:00:00+11:00",
      endAt: "",
      timezone: "Australia/Sydney",
      description: "",
      venueName: null,
      address: null,
      runOfShow: [],
      gettingThere: null,
      childrenPolicy: null,
      plusOnePolicy: null,
      guestPolicyNote: null,
      dressCodeDescription: null,
      dressCodePalette: [],
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder,
    };
  }
  const guest = (key: string, id: string | null, firstName: string, eventKeys: string[] = []) =>
    ({ key, id, firstName, lastName: "", nickname: null, eventKeys }) satisfies DraftGuest;
  const base = (): DraftState => ({
    events: [evt("e1", "evt_a", "A", 0), evt("e2", "evt_b", "B", 1)],
    families: [
      {
        key: "f1",
        id: "fam_s",
        publicId: "S-CODE",
        familyName: "Sharma",
        guests: [guest("g1", "g_ada", "Ada", ["e1"]), guest("g2", "g_ben", "Ben")],
      },
    ],
  });
  /** The same rows under fresh keys (`x` + key). */
  const fresh = (state: DraftState): DraftState => ({
    events: state.events.map((e) => ({ ...e, key: `x${e.key}` })),
    families: state.families.map((f) => ({
      ...f,
      key: `x${f.key}`,
      guests: f.guests.map((g) => ({
        ...g,
        key: `x${g.key}`,
        eventKeys: g.eventKeys.map((k) => `x${k}`),
      })),
    })),
  });

  it("keeps an existing guest's tick on an event the organiser added", () => {
    const b = base();
    const cur = structuredClone(b);
    cur.events.push(evt("n1", null, "C", 2));
    cur.families[0]!.guests[0]!.eventKeys.push("n1");
    const { draft, notes } = replayDraft(b, cur, fresh(b));
    expect(draft.families[0]!.guests[0]!.eventKeys).toEqual(["xe1", "n1"]);
    expect(notes).toEqual([]);
  });

  it("notes a new event or guest whose name was also added elsewhere", () => {
    const b = base();
    const cur = structuredClone(b);
    cur.events.push(evt("n1", null, "C", 2));
    cur.families[0]!.guests.push(guest("n2", null, "Cy"));
    const f = fresh(b);
    f.events.push(evt("xe9", "evt_c", "c", 2));
    f.families[0]!.guests.push(guest("xg9", "g_cy", "cy"));
    expect(replayDraft(b, cur, f).notes).toEqual([
      "An event called “C” was also added elsewhere — check for a duplicate.",
      "“Cy” was also added to “Sharma” elsewhere — check for a duplicate.",
    ]);
  });

  it("notes an edit to a guest removed elsewhere", () => {
    const b = base();
    const cur = structuredClone(b);
    cur.families[0]!.guests[1]!.lastName = "Sharma";
    const f = fresh(b);
    f.families[0]!.guests.splice(1, 1);
    const { draft, notes } = replayDraft(b, cur, f);
    expect(draft.families[0]!.guests.map((g) => g.firstName)).toEqual(["Ada"]);
    expect(notes).toEqual(["“Ben” was removed elsewhere, so your changes to them were not kept."]);
  });

  it("places an added event where the organiser put it when they also reordered", () => {
    const b = base();
    const cur = structuredClone(b);
    cur.events = [evt("n1", null, "New", 0), cur.events[1]!, cur.events[0]!];
    const f = fresh(b);
    f.events.push(evt("xe9", "evt_c", "Theirs", 2));
    expect(replayDraft(b, cur, f).draft.events.map((e) => [e.name, e.sortOrder])).toEqual([
      ["New", 0],
      ["B", 1],
      ["A", 2],
      ["Theirs", 3],
    ]);
  });
});
