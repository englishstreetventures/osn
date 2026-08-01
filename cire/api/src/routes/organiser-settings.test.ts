import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const CO_HOST = "usr_cohost";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";
const OTHER_EVENT_ID = "evt_other";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_1",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: CO_HOST,
      addedByOsnProfileId: OWNER,
      // Legacy pre-0031 value — normalised to editor by the gates.
      role: "host",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_viewer",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other Wedding",
      ownerOsnProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(events)
    .values({
      id: OTHER_EVENT_ID,
      weddingId: "wed_other",
      slug: "other-party",
      name: "Other Party",
      description: "",
      startAt: "2027-01-01T16:00:00+10:00",
      endAt: "2027-01-01T22:00:00+10:00",
      timezone: "Australia/Sydney",
      sortOrder: 0,
    })
    .run();
  const app = createApp(db, { osnTestKey: auth.key });
  return { db, app };
}

type App = ReturnType<typeof buildApp>["app"];

async function req(
  app: App,
  method: string,
  path: string,
  profileId?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return appRequest(app, path, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const SETTINGS_PATH = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/settings`;

/** First seeded event of the bootstrap wedding — the target for location tests. */
function firstEventId(db: Db): string {
  const row = db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
    .get();
  if (!row) throw new Error("no seeded event");
  return row.id;
}

describe("GET /api/organiser/weddings/:weddingId/settings", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", SETTINGS_PATH)).status).toBe(401);
  });

  it("returns 403 for a non-member", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", SETTINGS_PATH, STRANGER)).status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", "/api/organiser/weddings/wed_missing/settings", OWNER);
    expect(res.status).toBe(404);
  });

  it("returns the profile with defaults for the owner", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", SETTINGS_PATH, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wedding: Record<string, unknown> };
    expect(body.wedding).toEqual({
      id: BOOTSTRAP_WEDDING_ID,
      slug: "cire-wedding",
      displayName: "Cire Wedding",
      weddingDate: null,
      guestCountEstimate: null,
      currency: "AUD",
      budgetTotalMinor: null,
      rsvpDeadline: null,
      rsvpDeadlineTimezone: null,
    });
  });

  it("admits a VIEWER co-host on the settings read (member-level)", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", SETTINGS_PATH, VIEWER);
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/organiser/weddings/:weddingId/settings", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    expect((await req(app, "PUT", SETTINGS_PATH, undefined, {})).status).toBe(401);
  });

  it("returns 403 for a co-host writing an owner-only field", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, { displayName: "Renamed" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; fields: string[] };
    expect(body.error).toBe("owner_only_fields");
    expect(body.fields).toEqual(["displayName"]);
    // Refused whole, not partially applied.
    expect(getWedding(db).displayName).toBe("Cire Wedding");
  });

  it("names every owner-only field a co-host reached for", async () => {
    // The portal sends the deadline alone, so a body like this is a stale tab
    // or a hand-crafted call — worth an error that says exactly what was wrong.
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, {
      displayName: "Renamed",
      guestCountEstimate: 40,
      rsvpDeadline: "2027-02-20",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { fields: string[] };
    expect(body.fields.toSorted()).toEqual(["displayName", "guestCountEstimate"]);
    // The permitted half of a rejected patch is not applied either.
    expect(getWedding(db).rsvpDeadline).toBeNull();
  });

  it("refuses a co-host CLEARING an owner-only field", async () => {
    // Clearing is the destructive half of a write, and it is the case a
    // plausible refactor breaks: a truthiness check in the allow-list would
    // still pass every other test here while letting a co-host wipe the
    // wedding date, guest estimate and budget.
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: "2027-03-20" });
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, { weddingDate: null });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(["weddingDate"]);
    expect(getWedding(db).weddingDate).toBe("2027-03-20");
  });

  it("lets an EDITOR co-host set the RSVP deadline", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.rsvpDeadline).toBe("2027-02-20");
    expect(row.rsvpDeadlineTimezone).toBe("Australia/Sydney");
  });

  it("lets an EDITOR co-host clear the deadline (zone goes with it)", async () => {
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, {
      rsvpDeadline: null,
      rsvpDeadlineTimezone: null,
    });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.rsvpDeadline).toBeNull();
    expect(row.rsvpDeadlineTimezone).toBeNull();
  });

  it("writes only the columns the patch names, so a co-host can't clobber owner fields", async () => {
    // S-L1: the save used to read the row and write all seven columns back. A
    // co-host's deadline patch would then rewrite displayName/currency/budget
    // with whatever it read a moment earlier, reverting an owner's concurrent
    // edit to fields the gate exists to protect. Simulated here by moving an
    // owner-only column BETWEEN the co-host's read and their write.
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { displayName: "Aisha & Ben" });

    // The owner renames while the co-host's tab still shows the old name...
    await req(app, "PUT", SETTINGS_PATH, OWNER, { displayName: "Aisha & Benjamin" });
    // ...and the co-host saves the deadline.
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    expect(res.status).toBe(200);

    const row = getWedding(db);
    expect(row.rsvpDeadline).toBe("2027-02-20");
    // The rename survives — the co-host's UPDATE never named displayName.
    expect(row.displayName).toBe("Aisha & Benjamin");
  });

  describe("a deadline may not be set in the past (S-L3)", () => {
    // A backdated deadline locks the invite for every guest the moment it
    // lands, and a guest turned away is told only that RSVPs closed — never
    // that the date moved. Refused for EVERY caller, owner included.
    it("400s a backdated deadline from the owner", async () => {
      const { app, db } = buildApp();
      const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
        rsvpDeadline: "1970-01-01",
        rsvpDeadlineTimezone: "Australia/Sydney",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("rsvp_deadline_in_past");
      expect(getWedding(db).rsvpDeadline).toBeNull();
    });

    it("400s a backdated deadline from a co-host", async () => {
      const { app } = buildApp();
      const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, { rsvpDeadline: "1970-01-01" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("rsvp_deadline_in_past");
    });

    it("accepts TODAY — the deadline closes at the END of its day", async () => {
      // The organiser who wants to stop taking replies needs this, and it is
      // the boundary the rule must not eat. Computed in the stored zone so the
      // test doesn't drift with the runner's own clock.
      const { app, db } = buildApp();
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Australia/Sydney",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
        rsvpDeadline: today,
        rsvpDeadlineTimezone: "Australia/Sydney",
      });
      expect(res.status).toBe(200);
      expect(getWedding(db).rsvpDeadline).toBe(today);
    });

    it("leaves an already-past deadline alone when the patch doesn't name it", async () => {
      // A wedding whose deadline lapsed naturally must stay editable — the rule
      // is about the write, not about the row's current state.
      const { app, db } = buildApp();
      db.update(weddings)
        .set({ rsvpDeadline: "1999-01-01", rsvpDeadlineTimezone: "Australia/Sydney" })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
        .run();
      const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { guestCountEstimate: 80 });
      expect(res.status).toBe(200);
      expect(getWedding(db).rsvpDeadline).toBe("1999-01-01");
    });

    it("lets a save re-send an unchanged lapsed deadline", async () => {
      // The owner's form re-sends the whole profile on every save, so judging
      // the VALUE rather than the change would lock a wedding whose date has
      // passed out of its own Settings panel entirely.
      const { app, db } = buildApp();
      db.update(weddings)
        .set({ rsvpDeadline: "1999-01-01", rsvpDeadlineTimezone: "Australia/Sydney" })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
        .run();
      const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
        displayName: "Aisha & Ben",
        rsvpDeadline: "1999-01-01",
        rsvpDeadlineTimezone: "Australia/Sydney",
      });
      expect(res.status).toBe(200);
      expect(getWedding(db).displayName).toBe("Aisha & Ben");
    });

    it("still lets a lapsed deadline be CLEARED", async () => {
      const { app, db } = buildApp();
      db.update(weddings)
        .set({ rsvpDeadline: "1999-01-01", rsvpDeadlineTimezone: "Australia/Sydney" })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
        .run();
      const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, { rsvpDeadline: null });
      expect(res.status).toBe(200);
      const row = getWedding(db);
      expect(row.rsvpDeadline).toBeNull();
      expect(row.rsvpDeadlineTimezone).toBeNull();
    });
  });

  it("records who made the write (migration 0056)", async () => {
    // Two principal classes can now move a guest-facing control, so an owner
    // who finds RSVPs closed must be able to establish who did it.
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { guestCountEstimate: 80 });
    expect(getWedding(db).updatedByOsnProfileId).toBe(OWNER);

    await req(app, "PUT", SETTINGS_PATH, CO_HOST, { rsvpDeadline: "2027-02-20" });
    expect(getWedding(db).updatedByOsnProfileId).toBe(CO_HOST);
  });

  it("400s a co-host's malformed deadline before the privilege check", async () => {
    // Shape first: a co-host with a typo is told the date is wrong, not that
    // they lack permission for a field they're allowed to write.
    const { app } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, CO_HOST, { rsvpDeadline: "2027-02-31" });
    expect(res.status).toBe(400);
  });

  it("returns 403 read_only_role for a VIEWER co-host", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, VIEWER, { rsvpDeadline: "2027-02-20" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("returns 403 for a non-member", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, STRANGER, { rsvpDeadline: "2027-02-20" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", "/api/organiser/weddings/wed_missing/settings", OWNER, {});
    expect(res.status).toBe(404);
  });

  it("saves a full profile and persists it", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      displayName: "  Aisha & Ben  ",
      weddingDate: "2027-03-20",
      guestCountEstimate: 120,
      currency: "AUD",
      budgetTotalMinor: 4_500_000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wedding: { displayName: string; weddingDate: string } };
    expect(body.wedding.displayName).toBe("Aisha & Ben");
    expect(body.wedding.weddingDate).toBe("2027-03-20");

    const row = getWedding(db);
    expect(row.weddingDate).toBe("2027-03-20");
    expect(row.guestCountEstimate).toBe(120);
    expect(row.budgetTotalMinor).toBe(4_500_000);
  });

  it("patches only the provided fields", async () => {
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: "2027-03-20" });
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { guestCountEstimate: 80 });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.weddingDate).toBe("2027-03-20");
    expect(row.guestCountEstimate).toBe(80);
    expect(row.displayName).toBe("Cire Wedding");
  });

  it("clears a nullable field with an explicit null", async () => {
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: "2027-03-20" });
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: null });
    expect(res.status).toBe(200);
    expect(getWedding(db).weddingDate).toBeNull();
  });

  it("never writes the slug — a slug in the body is ignored (S-M1)", async () => {
    // Renaming would free the old slug for another organiser to claim while
    // printed invite links still point at it; the schema strips the field, so
    // even a hand-crafted body can't move it.
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      slug: "squatted-slug",
      displayName: "Renamed",
    });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.slug).toBe("cire-wedding");
    expect(row.displayName).toBe("Renamed");
  });

  it("400s malformed JSON, bad shapes, and impossible dates", async () => {
    const { app } = buildApp();
    const rawRes = await appRequest(app, SETTINGS_PATH, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await auth.sign(OWNER)}`,
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    expect(rawRes.status).toBe(400);

    for (const bad of [
      { weddingDate: "20-03-2027" },
      { weddingDate: "2027-02-31" },
      { currency: "dollars" },
      { guestCountEstimate: 2.5 },
      { budgetTotalMinor: -1 },
      { displayName: "   " },
      { rsvpDeadline: "01/09/2027" },
      { rsvpDeadline: "2027-02-31" },
      // A zone the runtime can't resolve would silently degrade the deadline to
      // UTC at read time — reject it at the boundary instead.
      { rsvpDeadlineTimezone: "Mars/Olympus_Mons" },
      { rsvpDeadlineTimezone: "GMT+11" },
      // Fixed-offset zones construct fine in `Intl` but never apply DST, so a
      // deadline stored as one drifts across a transition (S-L2).
      { rsvpDeadlineTimezone: "+05:30" },
      { rsvpDeadlineTimezone: "-14:00" },
    ]) {
      const res = await req(app, "PUT", SETTINGS_PATH, OWNER, bad);
      expect(res.status).toBe(400);
    }
  });

  it("saves an RSVP deadline with the organiser's zone", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wedding: { rsvpDeadline: string; rsvpDeadlineTimezone: string };
    };
    expect(body.wedding.rsvpDeadline).toBe("2027-02-20");
    expect(body.wedding.rsvpDeadlineTimezone).toBe("Australia/Sydney");

    const row = getWedding(db);
    expect(row.rsvpDeadline).toBe("2027-02-20");
    expect(row.rsvpDeadlineTimezone).toBe("Australia/Sydney");
  });

  it("clearing the deadline date also clears its zone", async () => {
    // The two columns are one fact — a zone left behind would re-show next to
    // an empty date in the portal and read as a deadline that isn't there.
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { rsvpDeadline: null });
    expect(res.status).toBe(200);

    const row = getWedding(db);
    expect(row.rsvpDeadline).toBeNull();
    expect(row.rsvpDeadlineTimezone).toBeNull();
    const body = (await res.json()) as { wedding: Record<string, unknown> };
    expect(body.wedding.rsvpDeadlineTimezone).toBeNull();
  });

  it("canonicalises the stored zone rather than storing it verbatim (S-L2)", async () => {
    // One zone must have one spelling in the column, or equal deadlines don't
    // compare equal and the value stops matching its documented type.
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "AUSTRALIA/sydney",
    });
    expect(res.status).toBe(200);

    expect(getWedding(db).rsvpDeadlineTimezone).toBe("Australia/Sydney");
    const body = (await res.json()) as { wedding: { rsvpDeadlineTimezone: string } };
    expect(body.wedding.rsvpDeadlineTimezone).toBe("Australia/Sydney");
  });

  it("refuses to store a zone against a wedding with no deadline date", async () => {
    // The other direction of the same invariant: not "clearing the date drops
    // the zone" but "a zone can never be the only half stored". A hand-crafted
    // body takes this path, and it is the branch that would strand an orphan
    // zone if the pairing guard ever moved inside the date-provided check.
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    expect(res.status).toBe(200);

    const row = getWedding(db);
    expect(row.rsvpDeadline).toBeNull();
    expect(row.rsvpDeadlineTimezone).toBeNull();
  });

  it("accepts a deadline with no zone (read back as UTC)", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { rsvpDeadline: "2027-02-20" });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.rsvpDeadline).toBe("2027-02-20");
    expect(row.rsvpDeadlineTimezone).toBeNull();
  });

  it("leaves the deadline alone when the patch omits it", async () => {
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, {
      rsvpDeadline: "2027-02-20",
      rsvpDeadlineTimezone: "Australia/Sydney",
    });
    await req(app, "PUT", SETTINGS_PATH, OWNER, { guestCountEstimate: 80 });
    const row = getWedding(db);
    expect(row.rsvpDeadline).toBe("2027-02-20");
    expect(row.rsvpDeadlineTimezone).toBe("Australia/Sydney");
  });
});

describe("event location config is gone (dropped by migration 0036)", () => {
  const EVENTS_PATH = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`;
  const POINT = { locationLat: -33.8688, locationLng: 151.2093, pricingRegion: "au-nsw" };

  it("404s the removed per-event location write route", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", `${EVENTS_PATH}/${firstEventId(db)}/location`, OWNER, POINT);
    // No such route now — Elysia has no handler for the path, so a 404 (not a
    // 200/400/403 from a live handler) proves the surface is gone.
    expect(res.status).toBe(404);
  });

  it("404s the removed settings/geocode route", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", `${SETTINGS_PATH}/geocode`, OWNER, { query: "Sydney" });
    expect(res.status).toBe(404);
  });

  it("the organiser events read carries no location fields", async () => {
    // The payload the portal seeds its event list from must not expose the
    // retired planning columns — an event's place is its free-text `address`.
    const { app } = buildApp();
    const res = await req(app, "GET", EVENTS_PATH, OWNER);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("locationLat");
      expect(row).not.toHaveProperty("locationLng");
      expect(row).not.toHaveProperty("pricingRegion");
      // The real location source is still there.
      expect(row).toHaveProperty("address");
    }
  });
});

function getWedding(db: Db) {
  const row = db.select().from(weddings).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).get();
  if (!row) throw new Error("bootstrap wedding missing");
  return row;
}
