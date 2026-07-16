import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, guests, rsvps, weddings, weddingHosts } from "@cire/db";
import { and, eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** An event id by slug in the bootstrap wedding. */
function eventBySlug(db: Db, slug: string): string {
  const row = db.select({ id: events.id }).from(events).where(eq(events.slug, slug)).get();
  if (!row) throw new Error(`no event ${slug}`);
  return row.id;
}

function guestByName(db: Db, firstName: string): string {
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

const rsvpPath = (db: Db, guestName = "Ada", slug = "hindu") =>
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

  it("returns 200 + persists consent record when dietary is attested", async () => {
    const { db, app } = buildApp();
    const res = await put(app, rsvpPath(db), OWNER, {
      status: "attending",
      dietary: "Coeliac",
      dietaryConsent: true,
    });
    expect(res.status).toBe(200);
    const row = db
      .select({ dietary: rsvps.dietary, at: rsvps.dietaryConsentAt })
      .from(rsvps)
      .where(
        and(eq(rsvps.guestId, guestByName(db, "Ada")), eq(rsvps.eventId, eventBySlug(db, "hindu"))),
      )
      .get();
    expect(row?.dietary).toBe("Coeliac");
    expect(row?.at).toBeInstanceOf(Date);
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
});
