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
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { DIETARY_CONSENT_VERSION } from "../schemas/rsvp";
import { organiserRsvpService } from "./organiser-rsvp";

// Ada (Testfamily) is invited to catholic + hindu + reception, NOT mehendi.
// (Mirrors the guest RSVP route test fixtures.)
let db: Db;
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
        dietary: "",
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
        dietary: "",
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
        dietary: "",
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
        dietary: "Coeliac",
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
        dietary: "",
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
          dietary: "",
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
          dietary: "",
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
          dietary: "",
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
          dietary: "",
          dietaryConsent: false,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("GuestNotInWedding");
  });
});
