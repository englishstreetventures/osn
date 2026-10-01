import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, guests, rsvps, weddings, weddingHosts } from "@cire/db";
import {
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
  PLUS_ONE_DIETARY_ATTESTATION,
} from "@cire/dietary";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { DIETARY_CONSENT_VERSION } from "../../src/schemas/rsvp";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { seedPlusOne } from "../test-helpers/plus-one";

/** The attestation fields the portal sends beside dietary data. */
const ATTESTED = {
  dietaryConsent: true,
  dietaryAttestation: ORGANISER_DIETARY_ATTESTATION.version,
};

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** An event id by slug in the bootstrap wedding. */
function eventBySlug(db: TestDb, slug: string): string {
  const row = db.select({ id: events.id }).from(events).where(eq(events.slug, slug)).get();
  if (!row) throw new Error(`no event ${slug}`);
  return row.id;
}

function guestByName(db: TestDb, firstName: string): string {
  const row = db
    .select({ id: guests.id })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .get();
  if (!row) throw new Error(`no guest ${firstName}`);
  return row.id;
}

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
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
  // A second wedding whose owner (usr_bob) is a stranger to the bootstrap one.
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
  const app = createApp(db, { osnTestKey: auth.key });
  return { db, app };
}

type App = ReturnType<typeof buildApp>["app"];

async function put(
  app: App,
  path: string,
  profileId: string | undefined,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "PUT", headers, body: JSON.stringify(body) });
}

const rsvpPath = (db: TestDb, guestName = "Ada", slug = "hindu") =>
  `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests/${guestByName(db, guestName)}/rsvps/${eventBySlug(db, slug)}`;

const OK_BODY = { status: "attending" as const };

describe("PUT /api/organiser/weddings/:weddingId/guests/:guestId/rsvps/:eventId", () => {
  it("returns 401 without a token (guest session / anonymous rejected)", async () => {
    const { db, app } = buildApp();
    expect((await put(app, rsvpPath(db), undefined, OK_BODY)).status).toBe(401);
  });

  it("returns 403 read_only_role for a viewer co-host", async () => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), VIEWER, OK_BODY);
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("read_only_role");
  });

  it("returns 403 forbidden for a non-member stranger", async () => {
    const { db, app } = buildApp();
    expect((await put(app, rsvpPath(db), STRANGER, OK_BODY)).status).toBe(403);
  });

  it("returns 200 for an editor and writes an organiser-attested row", async () => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), EDITOR, OK_BODY);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rsvp: { consentSource: string; status: string } };
    expect(data.rsvp.consentSource).toBe("organiser_attested");
    expect(data.rsvp.status).toBe("attending");

    const row = db
      .select({ source: rsvps.consentSource })
      .from(rsvps)
      .where(
        and(eq(rsvps.guestId, guestByName(db, "Ada")), eq(rsvps.eventId, eventBySlug(db, "hindu"))),
      )
      .get();
    expect(row?.source).toBe("organiser_attested");
  });

  it("returns 200 for the owner", async () => {
    const { db, app } = buildApp();
    expect((await put(app, rsvpPath(db), OWNER, OK_BODY)).status).toBe(200);
  });

  it("returns 400 for an out-of-set status", async () => {
    const { db, app } = buildApp();
    expect((await put(app, rsvpPath(db), OWNER, { status: "going" })).status).toBe(400);
  });

  it("returns 409 when the guest is not invited to the event (mehendi)", async () => {
    const { db, app } = buildApp();
    // Ada is not invited to mehendi.
    const res = await put(app, rsvpPath(db, "Ada", "mehendi"), OWNER, OK_BODY);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("guest_not_invited_to_event");
  });

  it("returns 422 when dietary is submitted without an attestation", async () => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      dietary: "Vegetarian",
      // dietaryConsent omitted → false
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when PRESETS alone are submitted without an attestation", async () => {
    // The mirror of the guest route's preset-only gate. The case above sends
    // free text, so a regression to the old free-text-only condition keeps it
    // green while storing `halal` + `nuts` — religious belief and a health
    // condition — against a NULL consent record.
    const { db, app } = buildApp();
    const guestId = guestByName(db, "Ada");
    const eventId = eventBySlug(db, "hindu");
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      dietaryPresets: ["halal", "nuts"],
      // no `dietary`, and `dietaryConsent` omitted → false
    });
    expect(res.status).toBe(422);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Dietary requirements need the guest's consent to store");

    // Nothing was written — the gate runs before the service.
    const row = db
      .select({ presets: rsvps.dietaryPresets })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, guestId), eq(rsvps.eventId, eventId)))
      .get();
    expect(row).toBeUndefined();
  });

  it("returns 200 + stores presets when a preset-only reply IS attested", async () => {
    const { db, app } = buildApp();
    const guestId = guestByName(db, "Ada");
    const eventId = eventBySlug(db, "hindu");
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      // Submitted allergy-first and with a repeat; stored diet-first and
      // deduplicated, because the server re-serialises what it is sent.
      dietaryPresets: ["nuts", "vegetarian", "nuts"],
      ...ATTESTED,
    });
    expect(res.status).toBe(200);
    const row = db
      .select({
        presets: rsvps.dietaryPresets,
        dietary: rsvps.dietary,
        at: rsvps.dietaryConsentAt,
      })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, guestId), eq(rsvps.eventId, eventId)))
      .get();
    // `parsePresets` is total, so a broken round trip returns [] rather than
    // throwing — the column itself is what has to be asserted.
    expect(row?.presets).toBe("vegetarian,nuts");
    // No free text, so no `other` is added on the organiser path either.
    expect(row?.dietary).toBe("");
    expect(row?.at).toBeInstanceOf(Date);
  });

  it("returns 200 + persists consent record when dietary is attested", async () => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      dietary: "Coeliac",
      ...ATTESTED,
    });
    expect(res.status).toBe(200);
    const row = db
      .select({
        dietary: rsvps.dietary,
        at: rsvps.dietaryConsentAt,
        version: rsvps.dietaryConsentVersion,
      })
      .from(rsvps)
      .where(
        and(eq(rsvps.guestId, guestByName(db, "Ada")), eq(rsvps.eventId, eventBySlug(db, "hindu"))),
      )
      .get();
    expect(row?.dietary).toBe("Coeliac");
    expect(row?.at).toBeInstanceOf(Date);
    // The row names the words the organiser ticked, not the guest's copy.
    expect(row?.version).toBe(ORGANISER_DIETARY_ATTESTATION.version);
  });

  // A portal built from another commit showed other words, or none: its tick
  // is refused rather than stored as evidence of copy nobody saw.
  it.each([
    { label: "no attestation version", dietaryAttestation: undefined },
    { label: "another attestation version", dietaryAttestation: "organiser-2000-01-01" },
  ])("returns 422 for attested dietary data with $label", async ({ dietaryAttestation }) => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      dietaryPresets: ["vegetarian"],
      dietaryConsent: true,
      dietaryAttestation,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("dietary_attestation_outdated");
    const row = db
      .select({ presets: rsvps.dietaryPresets })
      .from(rsvps)
      .where(
        and(eq(rsvps.guestId, guestByName(db, "Ada")), eq(rsvps.eventId, eventBySlug(db, "hindu"))),
      )
      .get();
    expect(row).toBeUndefined();
  });

  it("needs no attestation version for a status-only reply", async () => {
    const { db, app } = buildApp();
    expect((await put(app, rsvpPath(db), OWNER, { status: "declined" })).status).toBe(200);
  });

  it("returns 404 for an unknown wedding (multi-tenant isolation)", async () => {
    const { db, app } = buildApp();
    const path = `/api/organiser/weddings/wed_does_not_exist/guests/${guestByName(db, "Ada")}/rsvps/${eventBySlug(db, "hindu")}`;
    // usr_bob owns wed_other but has no seat on wed_does_not_exist → 404.
    expect((await put(app, path, OWNER, OK_BODY)).status).toBe(404);
  });

  it("returns 403 when a member of ANOTHER wedding targets the bootstrap wedding", async () => {
    const { db, app } = buildApp();
    // usr_bob owns wed_other, is a stranger to the bootstrap wedding → forbidden.
    expect((await put(app, rsvpPath(db), "usr_bob", OK_BODY)).status).toBe(403);
  });

  it("still records an RSVP after the wedding's RSVP deadline has passed", async () => {
    const { db, app } = buildApp();
    db.update(weddings)
      .set({ rsvpDeadline: "2020-01-01", rsvpDeadlineTimezone: "UTC", updatedAt: new Date() })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();

    // The deadline closes the GUEST invite (403 rsvp_closed on POST /api/rsvp);
    // it deliberately does not gate this endpoint. A reply that arrives by
    // phone or post after the date is precisely what an organiser needs to
    // enter, and they are the ones who set the date in the first place.
    const res = await put(app, rsvpPath(db), OWNER, OK_BODY);
    expect(res.status).toBe(200);
  });
});

describe("PUT …/rsvps/:eventId — a status-only reply over a guest's own answer", () => {
  it("keeps the guest's dietary answer, consent record and source", async () => {
    const { db, app } = buildApp();
    const adaId = guestByName(db, "Ada");
    const hindu = eventBySlug(db, "hindu");
    const consentAt = new Date("2026-09-20T10:00:00Z");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: adaId,
        eventId: hindu,
        status: "attending",
        dietary: "Coeliac",
        dietaryPresets: "gluten,other",
        dietaryConsentAt: consentAt,
        dietaryConsentVersion: DIETARY_CONSENT_VERSION,
        consentSource: "guest",
        createdAt: consentAt,
      })
      .run();

    const res = await put(app, rsvpPath(db), OWNER, { status: "declined" });
    expect(res.status).toBe(200);
    const row = db
      .select({
        status: rsvps.status,
        dietary: rsvps.dietary,
        presets: rsvps.dietaryPresets,
        at: rsvps.dietaryConsentAt,
        version: rsvps.dietaryConsentVersion,
        source: rsvps.consentSource,
      })
      .from(rsvps)
      .where(and(eq(rsvps.guestId, adaId), eq(rsvps.eventId, hindu)))
      .get();
    expect(row).toEqual({
      status: "declined",
      dietary: "Coeliac",
      presets: "gluten,other",
      at: consentAt,
      version: DIETARY_CONSENT_VERSION,
      source: "guest",
    });
  });

  it("refuses a guest's dietary data attested in the plus-one wording", async () => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      dietaryPresets: ["vegan"],
      dietaryConsent: true,
      dietaryAttestation: ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("dietary_attestation_mismatch");
  });
});

describe("PUT …/rsvps/:eventId — a plus-one's reply", () => {
  it("records a status-only reply, and refuses dietary data attested in the guest wording", async () => {
    const { db, app } = buildApp();
    const samId = seedPlusOne(db, guestByName(db, "Ada"), { firstName: "Sam" });
    const path = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests/${samId}/rsvps/${eventBySlug(db, "hindu")}`;

    expect((await put(app, path, OWNER, OK_BODY)).status).toBe(200);

    const refused = await put(app, path, OWNER, {
      status: "attending",
      dietaryPresets: ["halal"],
      ...ATTESTED,
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "plus_one_dietary_unavailable",
    );
    const row = db
      .select({ presets: rsvps.dietaryPresets })
      .from(rsvps)
      .where(eq(rsvps.guestId, samId))
      .get();
    expect(row?.presets).toBe("");
  });

  it("keeps the household's dietary answer on a status-only body, and replaces it once a dietary field is sent", async () => {
    const { db, app } = buildApp();
    const samId = seedPlusOne(db, guestByName(db, "Ada"), { firstName: "Sam" });
    const hindu = eventBySlug(db, "hindu");
    const path = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests/${samId}/rsvps/${hindu}`;
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: samId,
        eventId: hindu,
        status: "attending",
        dietaryPresets: "halal",
        dietaryConsentAt: new Date(),
        dietaryConsentVersion: PLUS_ONE_DIETARY_ATTESTATION.version,
        consentSource: "inviter_attested",
        createdAt: new Date(),
      })
      .run();
    const stored = () =>
      db
        .select({
          status: rsvps.status,
          presets: rsvps.dietaryPresets,
          source: rsvps.consentSource,
        })
        .from(rsvps)
        .where(eq(rsvps.guestId, samId))
        .get();

    const kept = await put(app, path, OWNER, { status: "maybe" });
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as { rsvp: unknown }).rsvp).toEqual({
      guestId: samId,
      eventId: hindu,
      status: "maybe",
      dietary: "",
      dietaryPresets: ["halal"],
      consentSource: "inviter_attested",
    });
    expect(stored()).toEqual({ status: "maybe", presets: "halal", source: "inviter_attested" });

    // One dietary field is enough to make it a dietary edit.
    const replaced = await put(app, path, OWNER, { status: "declined", dietaryPresets: [] });
    expect(replaced.status).toBe(200);
    expect(stored()).toEqual({ status: "declined", presets: "", source: "organiser_attested" });
  });

  it("treats an empty free-text field alone as a dietary edit", async () => {
    const { db, app } = buildApp();
    const samId = seedPlusOne(db, guestByName(db, "Ada"), { firstName: "Sam" });
    const hindu = eventBySlug(db, "hindu");
    db.insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: samId,
        eventId: hindu,
        status: "attending",
        dietaryPresets: "halal",
        dietaryConsentAt: new Date(),
        dietaryConsentVersion: PLUS_ONE_DIETARY_ATTESTATION.version,
        consentSource: "inviter_attested",
        createdAt: new Date(),
      })
      .run();

    const res = await put(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests/${samId}/rsvps/${hindu}`,
      OWNER,
      { status: "maybe", dietary: "" },
    );
    expect(res.status).toBe(200);
    const row = db
      .select({ presets: rsvps.dietaryPresets, source: rsvps.consentSource })
      .from(rsvps)
      .where(eq(rsvps.guestId, samId))
      .get();
    expect(row).toEqual({ presets: "", source: "organiser_attested" });
  });

  it("stores dietary data attested in the plus-one wording for the name the row carries", async () => {
    const { db, app } = buildApp();
    const samId = seedPlusOne(db, guestByName(db, "Ada"), { firstName: "Sam", lastName: "Lee" });
    const path = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests/${samId}/rsvps/${eventBySlug(db, "hindu")}`;
    const body = {
      status: "attending",
      dietaryPresets: ["halal"],
      dietaryConsent: true,
      dietaryAttestation: ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version,
    };
    const stored = () =>
      db
        .select({
          presets: rsvps.dietaryPresets,
          version: rsvps.dietaryConsentVersion,
          source: rsvps.consentSource,
        })
        .from(rsvps)
        .where(eq(rsvps.guestId, samId))
        .get();

    // A page opened before the household renamed them names someone else.
    const renamed = await put(app, path, OWNER, { ...body, dietaryAttestedName: "Alex Lee" });
    expect(renamed.status).toBe(409);
    expect(((await renamed.json()) as { error: string }).error).toBe("plus_one_changed");
    expect(stored()).toBeUndefined();

    // No name at all ties the tick to nobody.
    const unnamed = await put(app, path, OWNER, body);
    expect(unnamed.status).toBe(409);
    expect(stored()).toBeUndefined();

    const res = await put(app, path, OWNER, { ...body, dietaryAttestedName: "Sam Lee" });
    expect(res.status).toBe(200);
    expect(stored()).toEqual({
      presets: "halal",
      version: ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version,
      source: "organiser_attested",
    });
  });
});
