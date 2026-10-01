import { beforeEach, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  weddings,
} from "@cire/db";
import { PLUS_ONE_DIETARY_ATTESTATION } from "@cire/dietary";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { DIETARY_CONSENT_VERSION } from "../../src/schemas/rsvp";
import { organiserRsvpService } from "../../src/services/organiser-rsvp";
import { dietaryConsentVersionFor, rsvpService } from "../../src/services/rsvp";
import { seedPlusOne } from "../test-helpers/plus-one";

// Ada (Testfamily) is invited to catholic + hindu + reception, NOT mehendi.
// (Mirrors the guest RSVP route test fixtures.)
let db: TestDb;
let adaId: string;

/** An event id by slug in the bootstrap wedding. */
function eventBySlug(slug: string): string {
  const row = db.select({ id: events.id }).from(events).where(eq(events.slug, slug)).get();
  if (!row) throw new Error(`no event ${slug}`);
  return row.id;
}

const run = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

/** Seed a SECOND wedding with its own family + guest + event + invitation, so
 *  cross-tenant isolation can be exercised (wedding B's guest/event). */
function seedForeignWedding() {
  const now = new Date();
  db.insert(weddings)
    .values({
      id: "wed_foreign",
      slug: "foreign",
      displayName: "Foreign Wedding",
      ownerOsnProfileId: "usr_foreign_owner",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(families)
    .values({
      id: "fam_foreign",
      weddingId: "wed_foreign",
      publicId: "FOREIGN-FIG-ZZ99",
      familyName: "Foreigner",
      kind: "guest",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(guests)
    .values({
      id: "guest_foreign",
      familyId: "fam_foreign",
      firstName: "Zed",
      lastName: "Foreigner",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(events)
    .values({
      id: "evt_foreign",
      weddingId: "wed_foreign",
      slug: "foreign-party",
      name: "Foreign Party",
      description: "",
      startAt: "2027-05-01T16:00:00+10:00",
      endAt: "2027-05-01T22:00:00+10:00",
      timezone: "Australia/Sydney",
      sortOrder: 0,
    })
    .run();
  db.insert(guestEvents).values({ guestId: "guest_foreign", eventId: "evt_foreign" }).run();
}

beforeEach(() => {
  db = createDb(":memory:");
  seedDb(db);
  const ada = db.select({ id: guests.id }).from(guests).where(eq(guests.firstName, "Ada")).get();
  if (!ada) throw new Error("seed missing Ada");
  adaId = ada.id;
});

describe("organiserRsvpService.record", () => {
  it("upserts an RSVP stamped consent_source='organiser_attested'", async () => {
    const hindu = eventBySlug("hindu");
    const result = await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: { text: "", presets: [] },
        dietaryConsent: false,
      }),
    );
    expect(result.consentSource).toBe("organiser_attested");

    const row = db
      .select({ status: rsvps.status, source: rsvps.consentSource })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, hindu)))
      .get();
    expect(row?.status).toBe("attending");
    expect(row?.source).toBe("organiser_attested");
  });

  it("VISIBLY OVERWRITES a prior guest reply (guest → organiser)", async () => {
    const hindu = eventBySlug("hindu");
    // Simulate the guest's own reply first (default consent_source='guest').
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: adaId,
        eventId: hindu,
        status: "declined",
        dietary: "",
        consentSource: "guest",
        createdAt: new Date(),
      })
      .run();

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: { text: "", presets: [] },
        dietaryConsent: false,
      }),
    );

    // One row (upsert on the unique key), now organiser-attested + attending.
    const rows = db
      .select({ status: rsvps.status, source: rsvps.consentSource })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, hindu)))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("attending");
    expect(rows[0]?.source).toBe("organiser_attested");
  });

  it("a later guest reply overwrites an organiser answer back to consent_source='guest'", async () => {
    const hindu = eventBySlug("hindu");
    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "maybe",
        dietary: { text: "", presets: [] },
        dietaryConsent: false,
      }),
    );
    // The guest write path stamps consent_source='guest' (the default).
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: "",
        consentSource: "guest",
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rsvps.guestId, rsvps.eventId],
        set: { status: "attending", consentSource: "guest" },
      })
      .run();

    const row = db
      .select({ source: rsvps.consentSource })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, hindu)))
      .get();
    expect(row?.source).toBe("guest");
  });

  it("captures a dietary consent record when the organiser attests it", async () => {
    const hindu = eventBySlug("hindu");
    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: { text: "Coeliac", presets: [] },
        dietaryConsent: true,
      }),
    );
    const row = db
      .select({
        dietary: rsvps.dietary,
        at: rsvps.dietaryConsentAt,
        version: rsvps.dietaryConsentVersion,
        source: rsvps.consentSource,
      })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, hindu)))
      .get();
    expect(row?.dietary).toBe("Coeliac");
    expect(row?.at).toBeInstanceOf(Date);
    expect(row?.version).toBe(DIETARY_CONSENT_VERSION);
    expect(row?.source).toBe("organiser_attested");
  });

  it("does NOT stamp a dietary consent record when dietary is empty", async () => {
    const hindu = eventBySlug("hindu");
    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: { text: "", presets: [] },
        dietaryConsent: true,
      }),
    );
    const row = db
      .select({ at: rsvps.dietaryConsentAt, version: rsvps.dietaryConsentVersion })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, hindu)))
      .get();
    expect(row?.at).toBeNull();
    expect(row?.version).toBeNull();
  });

  it("rejects an event the guest is NOT invited to (GuestNotInvitedToEvent)", async () => {
    const mehendi = eventBySlug("mehendi"); // Ada is not invited to mehendi.
    const err = await run(
      organiserRsvpService
        .record({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: adaId,
          eventId: mehendi,
          status: "attending",
          dietary: { text: "", presets: [] },
          dietaryConsent: false,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("GuestNotInvitedToEvent");
    // No row written.
    const row = db
      .select({ id: rsvps.id })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, mehendi)))
      .get();
    expect(row).toBeUndefined();
  });

  it("TENANCY: organiser of wedding A cannot write wedding B's guest (GuestNotInWedding)", async () => {
    seedForeignWedding();
    const err = await run(
      organiserRsvpService
        .record({
          weddingId: BOOTSTRAP_WEDDING_ID, // acting as an editor of the bootstrap wedding
          guestId: "guest_foreign", // but targeting the FOREIGN wedding's guest
          eventId: "evt_foreign",
          status: "attending",
          dietary: { text: "", presets: [] },
          dietaryConsent: false,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("GuestNotInWedding");
    const row = db
      .select({ id: rsvps.id })
      .from(rsvps)
      .where(eq(rsvps.guestId, "guest_foreign"))
      .get();
    expect(row).toBeUndefined();
  });

  it("TENANCY: rejects an event that belongs to another wedding (EventNotInWedding)", async () => {
    seedForeignWedding();
    const err = await run(
      organiserRsvpService
        .record({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: adaId, // a real bootstrap guest
          eventId: "evt_foreign", // but a foreign wedding's event
          status: "attending",
          dietary: { text: "", presets: [] },
          dietaryConsent: false,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("EventNotInWedding");
  });

  it("rejects a host-preview family guest (GuestNotInWedding)", async () => {
    // The host-preview family is kind='host'; its guest must not be RSVP-able.
    const now = new Date();
    db.insert(families)
      .values({
        id: "fam_host",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "HOSTPRV-HAZ-HH00",
        familyName: "Host Preview",
        kind: "host",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(guests)
      .values({
        id: "guest_host",
        familyId: "fam_host",
        firstName: "Wedding",
        lastName: "Host",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const hindu = eventBySlug("hindu");
    db.insert(guestEvents).values({ guestId: "guest_host", eventId: hindu }).run();

    const err = await run(
      organiserRsvpService
        .record({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: "guest_host",
          eventId: hindu,
          status: "attending",
          dietary: { text: "", presets: [] },
          dietaryConsent: false,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("GuestNotInWedding");
  });
});

describe("organiserRsvpService.record — a plus-one's household-given dietary answer", () => {
  const consentAt = new Date("2026-09-20T10:00:00Z");

  /** Sam, Ada's plus-one, with the household's reply to the hindu event:
   *  attending, halal + a note, under the household's attestation. */
  function seedHouseholdReply() {
    const samId = seedPlusOne(db, adaId, { firstName: "Sam" });
    const hindu = eventBySlug("hindu");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: samId,
        eventId: hindu,
        status: "attending",
        dietary: "No sesame",
        dietaryPresets: "halal,other",
        dietaryConsentAt: consentAt,
        dietaryConsentVersion: PLUS_ONE_DIETARY_ATTESTATION.version,
        consentSource: "inviter_attested",
        createdAt: consentAt,
      })
      .run();
    return { samId, hindu };
  }

  function storedRow(guestId: string, eventId: string) {
    return db
      .select({
        status: rsvps.status,
        dietary: rsvps.dietary,
        presets: rsvps.dietaryPresets,
        at: rsvps.dietaryConsentAt,
        version: rsvps.dietaryConsentVersion,
        source: rsvps.consentSource,
      })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, guestId), eq(rsvps.eventId, eventId)))
      .all();
  }

  it("a status-only recording sets the status and keeps the answer, its consent record and its source", async () => {
    const { samId, hindu } = seedHouseholdReply();

    const result = await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: samId,
        eventId: hindu,
        status: "maybe",
        dietary: null,
        dietaryConsent: false,
      }),
    );

    const rows = storedRow(samId, hindu);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      status: "maybe",
      dietary: "No sesame",
      presets: "halal,other",
      at: consentAt,
      version: PLUS_ONE_DIETARY_ATTESTATION.version,
      source: "inviter_attested",
    });
    // The answer reports what is stored, not what was sent.
    expect(result).toEqual({
      guestId: samId,
      eventId: hindu,
      status: "maybe",
      dietary: "No sesame",
      dietaryPresets: ["halal", "other"],
      consentSource: "inviter_attested",
    });

    // The household's attestation still counts as current, so the invite's
    // box for Sam opens ticked over the answer it gave.
    const famId = db
      .select({ familyId: guests.familyId })
      .from(guests)
      .where(eq(guests.id, samId))
      .get()?.familyId;
    if (!famId) throw new Error("no family");
    const family = await run(rsvpService.getRsvpsForFamily(famId));
    const sams = family.find((r) => r.guestId === samId && r.eventId === hindu);
    expect(sams?.dietaryConsentCurrent).toBe(true);
  });

  it("a status-only recording over a household reply with no dietary data repoints the source to the organiser", async () => {
    const samId = seedPlusOne(db, adaId, { firstName: "Sam" });
    const hindu = eventBySlug("hindu");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: samId,
        eventId: hindu,
        status: "attending",
        consentSource: "inviter_attested",
        createdAt: consentAt,
      })
      .run();

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: samId,
        eventId: hindu,
        status: "declined",
        dietary: null,
        dietaryConsent: false,
      }),
    );

    const [row] = storedRow(samId, hindu);
    expect(row?.status).toBe("declined");
    expect(row?.source).toBe("organiser_attested");
    expect(row?.dietary).toBe("");
    expect(row?.version).toBeNull();
  });

  it("a status-only recording keeps the source while a consent record is held without answers", async () => {
    const samId = seedPlusOne(db, adaId, { firstName: "Sam" });
    const hindu = eventBySlug("hindu");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: samId,
        eventId: hindu,
        status: "attending",
        dietaryConsentAt: consentAt,
        dietaryConsentVersion: PLUS_ONE_DIETARY_ATTESTATION.version,
        consentSource: "inviter_attested",
        createdAt: consentAt,
      })
      .run();

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: samId,
        eventId: hindu,
        status: "maybe",
        dietary: null,
        dietaryConsent: false,
      }),
    );

    // Never a row naming the organiser while pinning the household's words.
    const [row] = storedRow(samId, hindu);
    expect(row?.source).toBe("inviter_attested");
    expect(row?.version).toBe(PLUS_ONE_DIETARY_ATTESTATION.version);
  });

  it("a status-only recording with no prior reply writes an organiser-attested row with no dietary data", async () => {
    const samId = seedPlusOne(db, adaId, { firstName: "Sam" });
    const hindu = eventBySlug("hindu");

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: samId,
        eventId: hindu,
        status: "attending",
        dietary: null,
        dietaryConsent: false,
      }),
    );

    expect(storedRow(samId, hindu)).toEqual([
      {
        status: "attending",
        dietary: "",
        presets: "",
        at: null,
        version: null,
        source: "organiser_attested",
      },
    ]);
  });

  it("a dietary edit replaces the household's answer and stamps the organiser as its source", async () => {
    const { samId, hindu } = seedHouseholdReply();

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: samId,
        eventId: hindu,
        status: "maybe",
        dietary: { text: "", presets: [] },
        dietaryConsent: false,
      }),
    );

    expect(storedRow(samId, hindu)).toEqual([
      {
        status: "maybe",
        dietary: "",
        presets: "",
        at: null,
        version: null,
        source: "organiser_attested",
      },
    ]);
  });

  it("a dietary edit carrying data is still refused for a plus-one, and the household's answer stays", async () => {
    const { samId, hindu } = seedHouseholdReply();

    const err = await run(
      organiserRsvpService
        .record({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: samId,
          eventId: hindu,
          status: "maybe",
          dietary: { text: "", presets: ["vegan"] },
          dietaryConsent: true,
        })
        .pipe(Effect.flip),
    );

    expect(err._tag).toBe("PlusOneDietaryUnavailable");
    expect(storedRow(samId, hindu)[0]?.presets).toBe("halal,other");
    expect(storedRow(samId, hindu)[0]?.source).toBe("inviter_attested");
  });

  it("a status-only recording for a member who is not a plus-one records no dietary data, as before", async () => {
    const hindu = eventBySlug("hindu");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: "Coeliac",
        dietaryConsentAt: consentAt,
        dietaryConsentVersion: DIETARY_CONSENT_VERSION,
        consentSource: "guest",
        createdAt: consentAt,
      })
      .run();

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "declined",
        dietary: null,
        dietaryConsent: false,
      }),
    );

    const [row] = storedRow(adaId, hindu);
    expect(row?.dietary).toBe("");
    expect(row?.version).toBeNull();
    expect(row?.source).toBe("organiser_attested");
  });

  it("a dietary edit for a member stamps the organiser's attestation over the guest's own answer", async () => {
    const hindu = eventBySlug("hindu");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: "Coeliac",
        consentSource: "guest",
        createdAt: consentAt,
      })
      .run();

    await run(
      organiserRsvpService.record({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: { text: "", presets: ["vegan"] },
        dietaryConsent: true,
      }),
    );

    const [row] = storedRow(adaId, hindu);
    expect(row?.presets).toBe("vegan");
    expect(row?.dietary).toBe("");
    expect(row?.source).toBe("organiser_attested");
    expect(row?.at).toBeInstanceOf(Date);
    expect(row?.version).toBe(dietaryConsentVersionFor("organiser_attested"));
  });
});
