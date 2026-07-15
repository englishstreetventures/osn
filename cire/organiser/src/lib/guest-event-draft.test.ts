import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EventRow } from "./events-store";
import {
  createGuestEventDraft,
  type DesiredStateWire,
  toDesiredState,
  validateDraft,
} from "./guest-event-draft";
import type { OrganiserGuestRow } from "./guests-store";

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
    locationLat: null,
    locationLng: null,
    pricingRegion: null,
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
    locationLat: null,
    locationLng: null,
    pricingRegion: null,
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

function loaded() {
  const store = createGuestEventDraft();
  store.load(EVENTS, GUESTS);
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
