import { describe, it, expect, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  emailSuppressions,
  events,
  families,
  guests,
  imports,
  weddingHosts,
} from "@cire/db";
import { GUEST_EMAIL_CONSENT, ORGANISER_EMAIL_ATTESTATION } from "@cire/guest-email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { CIRE_METRICS } from "../../src/metrics";
import { hashGuestEmail } from "../../src/services/email-suppression";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { createR2Stub } from "../../src/services/r2-imports";
import { appRequest, jsonBody } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Guest email addresses through the change pipeline: a spreadsheet's
// `Guest Email` column, the guest editor's draft, apply's attestation gate,
// the before-image and revert. Each test is one way the pipeline could store
// an address nobody consented to, lose or forge the consent record, or touch
// an address a guest gave themselves.

const OWNER = "usr_dev_bootstrap_owner";
const BASE = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}`;
const CHANGES = `${BASE}/changes`;
const ATTESTED = { emailAttestation: ORGANISER_EMAIL_ATTESTATION.version };

let auth: OsnTestAuth;
let bearer: string;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
  bearer = await auth.sign(OWNER);
});

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney",
  "Reception,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney",
].join("\n");

/** The guests sheet with a `Guest Email` column; "" is a blank cell. */
function guestsCsv(ada: string, bo: string): string {
  return [
    "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Email,Mehndi,Reception",
    `1,Testfamily,Ada,Testfamily,${ada},yes,yes`,
    `2,Sampleton,Bo,Sampleton,${bo},no,yes`,
  ].join("\n");
}

/** The same guests with no `Guest Email` column at all. */
const GUESTS_CSV_NO_EMAIL = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
  "1,Testfamily,Ada,Testfamily,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,yes",
].join("\n");

function buildApp() {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  // Room for the guest sessions some tests open, whatever the file runs first.
  const limiter = () => createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 });
  const app = createApp(db, {
    r2,
    osnTestKey: auth.key,
    claimLimiter: limiter(),
    claimSessionLimiter: limiter(),
  });
  return { db, r2, app };
}

type App = ReturnType<typeof buildApp>["app"];

function post(app: App, path: string, body: object) {
  return appRequest(app, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function get(app: App, path: string) {
  return appRequest(app, path, { method: "GET", headers: { Authorization: `Bearer ${bearer}` } });
}

interface Preview {
  changeId: string;
  emailAttestations: number;
  warnings: string[];
}

async function preview(app: App, body: object): Promise<Preview> {
  const res = await post(app, `${CHANGES}/preview`, body);
  expect(res.status).toBe(200);
  return (await res.json()) as Preview;
}

function apply(app: App, changeId: string, extra: object = {}) {
  return post(app, `${CHANGES}/apply`, { changeId, ...extra });
}

/** Preview and apply, attested, expecting both to succeed. */
async function change(app: App, body: object): Promise<string> {
  const p = await preview(app, body);
  const res = await apply(app, p.changeId, ATTESTED);
  expect(res.status).toBe(200);
  return p.changeId;
}

async function revert(app: App, changeId: string) {
  const res = await post(app, `${CHANGES}/revert`, { changeId });
  expect(res.status).toBe(200);
}

/** The two seeded households, Ada's address `ada`. */
async function seeded(app: App, ada = "ada@example.test", bo = ""): Promise<string> {
  return change(app, { eventsCsv: EVENTS_CSV, guestsCsv: guestsCsv(ada, bo) });
}

function guestId(db: TestDb, firstName: string): string {
  const row = db
    .select({ id: guests.id })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .get();
  if (!row) throw new Error(`no guest named ${firstName}`);
  return row.id;
}

function record(db: TestDb, firstName: string) {
  return db
    .select({
      email: guests.email,
      source: guests.emailSource,
      consentAt: guests.emailConsentAt,
      version: guests.emailConsentVersion,
      attestedBy: guests.emailAttestedByOsnProfileId,
    })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .get();
}

/** Give `firstName` an address as a guest would have on the invite. */
function guestGave(db: TestDb, firstName: string, email: string) {
  db.update(guests)
    .set({
      email,
      emailSource: "guest",
      emailConsentAt: new Date(1_700_000_000_000),
      emailConsentVersion: GUEST_EMAIL_CONSENT.version,
      emailAttestedByOsnProfileId: null,
    })
    .where(eq(guests.firstName, firstName))
    .run();
}

/** An editor draft of the two households, built from the stored rows. */
function draft(
  db: TestDb,
  edits: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const rows = db
    .select({
      familyId: families.id,
      publicId: families.publicId,
      familyName: families.familyName,
      guestId: guests.id,
      firstName: guests.firstName,
      lastName: guests.lastName,
      nickname: guests.nickname,
    })
    .from(guests)
    .innerJoin(families, eq(families.id, guests.familyId))
    .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
    .all();
  return {
    scope: "guests",
    removeManual: true,
    desiredState: {
      events: [],
      families: rows.map((r) => ({
        id: r.familyId,
        publicId: r.publicId,
        familyName: r.familyName,
        guests: [
          {
            id: r.guestId,
            firstName: r.firstName,
            lastName: r.lastName,
            nickname: r.nickname,
            eventNames: r.firstName === "Ada" ? ["Mehndi", "Reception"] : ["Reception"],
            ...edits[r.firstName],
          },
        ],
      })),
    },
  };
}

async function editorChange(app: App, db: TestDb, edits: Record<string, Record<string, unknown>>) {
  const head = ((await (await get(app, `${CHANGES}/head`)).json()) as { revision: string })
    .revision;
  return preview(app, { ...draft(db, edits), baseRevision: head });
}

describe("apply's attestation gate", () => {
  it("refuses an address with no attestation, and writes and checkpoints nothing", async () => {
    const { db, app } = buildApp();
    const p = await preview(app, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: guestsCsv("ada@example.test", ""),
    });
    expect(p.emailAttestations).toBe(1);

    const res = await apply(app, p.changeId);
    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toMatchObject({ reason: "email_attestation_required" });
    expect(db.select().from(guests).all()).toHaveLength(0);
    const [row] = db.select().from(imports).where(eq(imports.id, p.changeId)).all();
    expect(row?.status).toBe("preview");
    expect(row?.beforeGuestsR2Key).toBeNull();
  });

  it("refuses an attestation naming words the portal did not show", async () => {
    const { db, app } = buildApp();
    const p = await preview(app, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: guestsCsv("ada@example.test", ""),
    });
    for (const emailAttestation of ["organiser-email-2020-01-01", GUEST_EMAIL_CONSENT.version]) {
      const res = await apply(app, p.changeId, { emailAttestation });
      expect(res.status).toBe(422);
    }
    expect(db.select().from(guests).all()).toHaveLength(0);
  });

  it("stamps each address it sets as the applying organiser's attestation", async () => {
    const { db, app } = buildApp();
    await seeded(app, "  Ada@Example.TEST ");
    const ada = record(db, "Ada")!;
    expect(ada).toMatchObject({
      email: "ada@example.test",
      source: "organiser_attested",
      version: ORGANISER_EMAIL_ATTESTATION.version,
      attestedBy: OWNER,
    });
    expect(ada.consentAt).toBeInstanceOf(Date);
    expect(record(db, "Bo")?.email).toBeNull();
  });

  // Re-uploading a sheet whose addresses are already stored sets nothing, so
  // the organiser attests nothing.
  it("asks for no attestation when no address changes", async () => {
    const { app } = buildApp();
    await seeded(app);
    const p = await preview(app, { guestsCsv: guestsCsv("ada@example.test", "") });
    expect(p.emailAttestations).toBe(0);
    expect((await apply(app, p.changeId)).status).toBe(200);
  });

  // The record a revert carries belongs to the before-image only. An editor
  // body that sends one must not be believed.
  it("ignores a consent record an editor body carries, and still asks for the attestation", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const p = await editorChange(app, db, {
      Bo: {
        email: "bo@example.test",
        emailRecord: { source: "guest", consentAt: 0, version: "x", attestedBy: null },
      },
    });
    expect(p.emailAttestations).toBe(1);
    expect((await apply(app, p.changeId)).status).toBe(422);
    expect((await apply(app, p.changeId, ATTESTED)).status).toBe(200);
    expect(record(db, "Bo")).toMatchObject({ source: "organiser_attested", attestedBy: OWNER });
  });
});

describe("addresses a guest gave themselves", () => {
  it("are never overwritten or cleared by a spreadsheet, which says so", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    guestGave(db, "Ada", "ada.own@example.test");
    const before = record(db, "Ada");

    const changed = await preview(app, { guestsCsv: guestsCsv("other@example.test", "") });
    expect(changed.warnings.join(" ")).toContain("gave themselves");
    expect((await apply(app, changed.changeId, ATTESTED)).status).toBe(200);
    expect(record(db, "Ada")).toEqual(before);

    const blanked = await preview(app, { guestsCsv: guestsCsv("", "") });
    expect((await apply(app, blanked.changeId, ATTESTED)).status).toBe(200);
    expect(record(db, "Ada")).toEqual(before);
  });

  it("can be removed from the editor, and not replaced there", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    guestGave(db, "Ada", "ada.own@example.test");

    const replaced = await editorChange(app, db, {
      Ada: { email: "other@example.test", emailExpected: "ada.own@example.test" },
    });
    expect(replaced.emailAttestations).toBe(0);
    expect((await apply(app, replaced.changeId)).status).toBe(200);
    expect(record(db, "Ada")?.email).toBe("ada.own@example.test");

    const removed = await editorChange(app, db, {
      Ada: { email: null, emailExpected: "ada.own@example.test" },
    });
    expect((await apply(app, removed.changeId)).status).toBe(200);
    expect(record(db, "Ada")).toEqual({
      email: null,
      source: null,
      consentAt: null,
      version: null,
      attestedBy: null,
    });
  });
});

describe("what a change leaves alone", () => {
  it("leaves every address as it is when the sheet has no Guest Email column", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const before = record(db, "Ada");
    const p = await preview(app, { guestsCsv: GUESTS_CSV_NO_EMAIL });
    expect((await apply(app, p.changeId)).status).toBe(200);
    expect(record(db, "Ada")).toEqual(before);
  });

  // The editor sends the address it loaded. When the stored one has moved
  // since — a guest saved their own on the invite — the editor's write is stale.
  it("skips an editor's address change when the stored address moved since the editor loaded", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    db.update(guests).set({ email: "moved@example.test" }).where(eq(guests.firstName, "Ada")).run();
    const p = await editorChange(app, db, {
      Ada: { email: "new@example.test", emailExpected: "ada@example.test" },
    });
    expect(p.warnings.join(" ")).toContain("since you opened the editor");
    expect((await apply(app, p.changeId, ATTESTED)).status).toBe(200);
    expect(record(db, "Ada")?.email).toBe("moved@example.test");
  });

  // The diff decides against the rows it read; a guest's save can land
  // between that read and the commit. The write must not overwrite it.
  it("does not overwrite an address that changed between the diff and the commit", async () => {
    const { db } = buildApp();
    const run = <A, E>(effect: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));
    // Two households, Ada without an address, straight into the database.
    db.insert(families)
      .values({
        id: "fam_ada",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "ADA-CODE-1",
        familyName: "Testfamily",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    db.insert(guests)
      .values({
        id: "gst_ada",
        familyId: "fam_ada",
        firstName: "Ada",
        lastName: "Testfamily",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const plan = await run(
      diffAgainstDb(
        [],
        [
          {
            id: "fam_ada",
            familyName: "Testfamily",
            guests: [
              {
                id: "gst_ada",
                firstName: "Ada",
                lastName: "Testfamily",
                nickname: null,
                eventNames: [],
                email: "organiser@example.test",
              },
            ],
          },
        ],
        BOOTSTRAP_WEDDING_ID,
        { scope: "guests", matchByName: false, removeManual: true, emails: "editor" },
      ),
    );
    guestGave(db, "Ada", "guest.own@example.test");
    await run(
      applyImport("imp_race", plan, BOOTSTRAP_WEDDING_ID, [], {
        emailStamp: { osnProfileId: OWNER, version: ORGANISER_EMAIL_ATTESTATION.version },
      }),
    );
    expect(record(db, "Ada")?.email).toBe("guest.own@example.test");
  });

  it("refuses a sheet whose Guest Email cell is not an address, without echoing it", async () => {
    const { db, app } = buildApp();
    const res = await post(app, `${CHANGES}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: guestsCsv("not-an-address-xq7@nowhere", ""),
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("Guest Email");
    expect(text).not.toContain("xq7");
    expect(db.select().from(guests).all()).toHaveLength(0);
  });
});

describe("revert", () => {
  it("removes the addresses the reverted change added", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const added = await change(app, { guestsCsv: guestsCsv("ada@example.test", "") });
    await revert(app, added);
    expect(record(db, "Ada")?.email).toBeNull();
  });

  it("restores an address the reverted change cleared, with its original record", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const original = record(db, "Ada");
    const cleared = await change(app, { guestsCsv: guestsCsv("", "") });
    expect(record(db, "Ada")?.email).toBeNull();
    await revert(app, cleared);
    expect(record(db, "Ada")).toEqual(original);
  });

  it("never changes an address the guest gave since the checkpoint", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const added = await change(app, { guestsCsv: guestsCsv("ada@example.test", "") });
    guestGave(db, "Ada", "ada.own@example.test");
    const before = record(db, "Ada");
    await revert(app, added);
    expect(record(db, "Ada")).toEqual(before);
  });

  // A guest who removed their address withdrew it; a revert to a time before
  // that must not put it back under a consent record that no longer stands.
  it("never restores an address the guest withdrew", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const unrelated = await change(app, {
      guestsCsv: guestsCsv("ada@example.test", "bo@example.test"),
    });
    const ada = guestId(db, "Ada");
    db.update(guests)
      .set({
        email: null,
        emailSource: null,
        emailConsentAt: null,
        emailConsentVersion: null,
        emailAttestedByOsnProfileId: null,
      })
      .where(eq(guests.id, ada))
      .run();
    db.insert(emailSuppressions)
      .values({
        id: "sup_ada",
        weddingId: BOOTSTRAP_WEDDING_ID,
        emailHash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "ada@example.test"),
        guestId: ada,
        reason: "guest_removed",
        createdAt: new Date(),
      })
      .run();
    await revert(app, unrelated);
    expect(record(db, "Ada")?.email).toBeNull();
    expect(record(db, "Bo")?.email).toBeNull();
  });

  // Before-images written before addresses existed have no Guest Email
  // column. Silence about addresses is not "nobody has one".
  it("leaves addresses alone when the before-image has no Guest Email column", async () => {
    const { db, r2, app } = buildApp();
    await seeded(app, "ada@example.test");
    const later = await change(app, {
      guestsCsv: guestsCsv("ada@example.test", "bo@example.test"),
    });
    const [row] = db.select().from(imports).where(eq(imports.id, later)).all();
    const key = row!.beforeGuestsR2Key!;
    const csv = await (await r2.get(key))!.text();
    const lines = csv.split("\n").filter((l) => l.length > 0);
    const header = lines[0]!.split(",");
    const drop = new Set(
      header.flatMap((h, i) => (h.replaceAll('"', "").startsWith("Guest Email") ? [i] : [])),
    );
    expect(drop.size).toBeGreaterThan(0);
    const stripped = lines
      .map((l) =>
        l
          .split(",")
          .filter((_, i) => !drop.has(i))
          .join(","),
      )
      .join("\n");
    await r2.put(key, stripped);
    await revert(app, later);
    expect(record(db, "Ada")?.email).toBe("ada@example.test");
    expect(record(db, "Bo")?.email).toBe("bo@example.test");
  });

  // An events revert that brings an event back reads the guests before-image
  // only to re-invite. A damaged consent record there must not stop it.
  it("restores a deleted event even when the before-image's consent record is unreadable", async () => {
    const { db, r2, app } = buildApp();
    await seeded(app, "ada@example.test");
    const reception = db.select().from(events).where(eq(events.name, "Reception")).all()[0]!;
    const head = ((await (await get(app, `${CHANGES}/head`)).json()) as { revision: string })
      .revision;
    const p = await preview(app, {
      scope: "events",
      removeManual: true,
      baseRevision: head,
      desiredState: {
        families: [],
        events: [
          {
            id: reception.id,
            name: reception.name,
            startAt: reception.startAt,
            endAt: reception.endAt,
            timezone: reception.timezone,
            location: null,
            address: null,
            dressCodeDescription: null,
            dressCodePalette: [],
            pinterestUrl: null,
            mapsUrl: null,
            sortOrder: 0,
          },
        ],
      },
    });
    expect((await apply(app, p.changeId)).status).toBe(200);
    expect(db.select().from(events).where(eq(events.name, "Mehndi")).all()).toHaveLength(0);

    const [row] = db.select().from(imports).where(eq(imports.id, p.changeId)).all();
    const key = row!.beforeGuestsR2Key!;
    const csv = await (await r2.get(key))!.text();
    expect(csv).toContain("organiser_attested");
    const tampered = csv.replace(/"\{[^\n]*\}"/, '"{not json"');
    expect(tampered).not.toBe(csv);
    await r2.put(key, tampered);
    await revert(app, p.changeId);
    expect(db.select().from(events).where(eq(events.name, "Mehndi")).all()).toHaveLength(1);
    expect(record(db, "Ada")?.email).toBe("ada@example.test");
  });

  // The legacy replay re-applies an earlier upload's sheet. It carries no
  // attestation, so it must not set, replace or clear any address.
  it("touches no address when it replays an earlier upload", async () => {
    const { db, app } = buildApp();
    await seeded(app, "first@example.test");
    const later = await change(app, { guestsCsv: guestsCsv("second@example.test", "") });
    db.update(imports)
      .set({ beforeEventsR2Key: null, beforeGuestsR2Key: null })
      .where(eq(imports.id, later))
      .run();
    await revert(app, later);
    expect(record(db, "Ada")?.email).toBe("second@example.test");
  });
});

describe("GET /guests", () => {
  it("marks an address its wedding has suppressed as opted out", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test", "bo@example.test");
    db.insert(emailSuppressions)
      .values({
        id: "sup_bo",
        weddingId: BOOTSTRAP_WEDDING_ID,
        emailHash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "bo@example.test"),
        guestId: null,
        reason: "guest_removed",
        createdAt: new Date(),
      })
      .run();
    // The host preview's seat is not a guest, and stays off the list.
    db.insert(families)
      .values({
        id: "fam_host",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "HOST-AAAA",
        familyName: "Wedding Host",
        kind: "host",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    db.insert(guests)
      .values({
        id: "gst_host",
        familyId: "fam_host",
        firstName: "Hosty",
        lastName: "McHost",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const res = await get(app, `${BASE}/guests`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      firstName: string;
      email: string | null;
      emailSource: string | null;
      emailOptedOut: boolean;
    }[];
    const byName = new Map(rows.map((r) => [r.firstName, r]));
    expect(byName.get("Ada")).toMatchObject({
      email: "ada@example.test",
      emailSource: "organiser_attested",
      emailOptedOut: false,
    });
    expect(byName.get("Bo")).toMatchObject({ email: "bo@example.test", emailOptedOut: true });
    expect(byName.has("Hosty")).toBe(false);
  });
});

describe("more of what a change must not do to an address", () => {
  it("refuses an editor draft whose address is not one, or is past the raw cap", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const head = ((await (await get(app, `${CHANGES}/head`)).json()) as { revision: string })
      .revision;
    // The raw cap counts the text as sent, padding included: 1,024 characters
    // pass, 1,025 do not, even when trimming would leave one address.
    for (const email of [
      "Bo <bo@example.test>",
      `${"b".repeat(1020)}@example.test`,
      `${" ".repeat(1010)}bo@example.test`,
    ]) {
      const res = await post(app, `${CHANGES}/preview`, {
        ...draft(db, { Bo: { email } }),
        baseRevision: head,
      });
      expect(res.status).toBe(400);
    }
    expect(record(db, "Bo")?.email).toBeNull();
    const atCap = await post(app, `${CHANGES}/preview`, {
      ...draft(db, { Bo: { email: `${" ".repeat(1009)}bo@example.test` } }),
      baseRevision: head,
    });
    expect(atCap.status).toBe(200);
  });

  // `emailExpected` is optional on the wire: an editor body without it asks
  // for no check against the stored address, and its change applies.
  it("applies an editor address change that names no expected address", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const p = await editorChange(app, db, { Ada: { email: "ada.new@example.test" } });
    expect(p.emailAttestations).toBe(1);
    expect(p.warnings).toEqual([]);
    expect((await apply(app, p.changeId, ATTESTED)).status).toBe(200);
    expect(record(db, "Ada")?.email).toBe("ada.new@example.test");
  });

  // A field of spaces is a blank field: it clears the address, and a clear
  // sets nothing on the organiser's word, so it needs no attestation.
  it("clears an address the editor sends as spaces, with no attestation", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const p = await editorChange(app, db, {
      Ada: { email: "   ", emailExpected: "ada@example.test" },
    });
    expect(p.emailAttestations).toBe(0);
    expect((await apply(app, p.changeId)).status).toBe(200);
    expect(record(db, "Ada")?.email).toBeNull();
  });

  // The route refuses an unattested apply before the service runs; the
  // service refuses one too, so no other caller can store an address on
  // nobody's word.
  it("refuses, in the apply service itself, an address set with no attestation", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const run = <A, E>(effect: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));
    const ada = db.select().from(guests).where(eq(guests.firstName, "Ada")).all()[0]!;
    const plan = await run(
      diffAgainstDb(
        [],
        [
          {
            id: ada.familyId,
            familyName: "Testfamily",
            guests: [
              {
                id: ada.id,
                firstName: "Ada",
                lastName: "Testfamily",
                nickname: null,
                eventNames: ["Mehndi", "Reception"],
                email: "ada@example.test",
              },
            ],
          },
        ],
        BOOTSTRAP_WEDDING_ID,
        { scope: "guests", matchByName: false, removeManual: false, emails: "upload" },
      ),
    );
    expect(plan.emailWrites).toHaveLength(1);
    const failure = await run(
      Effect.flip(applyImport("imp_unattested", plan, BOOTSTRAP_WEDDING_ID)),
    );
    expect(failure._tag).toBe("ImportError");
    expect(record(db, "Ada")?.email).toBeNull();
  });

  it("says where the bad Guest Email cell is", async () => {
    const { app } = buildApp();
    const res = await post(app, `${CHANGES}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: guestsCsv("not-an-address", ""),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      reason: "Guest Email is not a valid email address",
      row: 2,
      column: 5,
    });
  });

  // The organiser attests the guest agreed; a guest who withdrew that address
  // has said the opposite, and the organiser must see that before attesting.
  it("warns, before the attestation, that an address being added was withdrawn", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    db.insert(emailSuppressions)
      .values({
        id: "sup_bo",
        weddingId: BOOTSTRAP_WEDDING_ID,
        emailHash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "bo@example.test"),
        guestId: null,
        reason: "guest_removed",
        createdAt: new Date(),
      })
      .run();
    const p = await preview(app, { guestsCsv: guestsCsv("", "bo@example.test") });
    expect(p.warnings.join(" ")).toContain("removed or replaced by the guest");
    expect(p.warnings.join(" ")).not.toContain("bo@example.test");
    expect((await apply(app, p.changeId, ATTESTED)).status).toBe(200);
  });

  // A guest who re-saves the same address as their own between the diff and
  // the commit has made it theirs: the organiser's planned clear must not land.
  it("does not clear an address a guest made their own between the diff and the commit", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const run = <A, E>(effect: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));
    const ada = db.select().from(guests).where(eq(guests.firstName, "Ada")).all()[0]!;
    const plan = await run(
      diffAgainstDb(
        [],
        [
          {
            id: ada.familyId,
            familyName: "Testfamily",
            guests: [
              {
                id: ada.id,
                firstName: "Ada",
                lastName: "Testfamily",
                nickname: null,
                eventNames: ["Mehndi", "Reception"],
                email: null,
                emailExpected: "ada@example.test",
              },
            ],
          },
        ],
        BOOTSTRAP_WEDDING_ID,
        { scope: "guests", matchByName: false, removeManual: false, emails: "editor" },
      ),
    );
    expect(plan.emailWrites).toHaveLength(1);
    guestGave(db, "Ada", "ada@example.test");
    await run(applyImport("imp_same_address", plan, BOOTSTRAP_WEDDING_ID));
    expect(record(db, "Ada")).toMatchObject({ email: "ada@example.test", source: "guest" });
  });

  // An objection outlives the seat: deleting the guest keeps the opt-out, and
  // the same address on a new guest of the wedding reads as opted out.
  it("keeps an opt-out when its guest is deleted", async () => {
    const { db, app } = buildApp();
    await seeded(app, "", "bo@example.test");
    const bo = guestId(db, "Bo");
    db.insert(emailSuppressions)
      .values({
        id: "sup_bo_seat",
        weddingId: BOOTSTRAP_WEDDING_ID,
        emailHash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "bo@example.test"),
        guestId: bo,
        reason: "guest_removed",
        createdAt: new Date(),
      })
      .run();
    await change(app, {
      guestsCsv: [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Email,Mehndi,Reception",
        "1,Testfamily,Ada,Testfamily,,yes,yes",
      ].join("\n"),
      removeManual: true,
    });
    expect(db.select().from(guests).where(eq(guests.firstName, "Bo")).all()).toHaveLength(0);
    expect(db.select({ guestId: emailSuppressions.guestId }).from(emailSuppressions).all()).toEqual(
      [{ guestId: null }],
    );

    await change(app, { guestsCsv: guestsCsv("", "bo@example.test") });
    const rows = (await (await get(app, `${BASE}/guests`)).json()) as {
      firstName: string;
      emailOptedOut: boolean;
    }[];
    expect(rows.find((r) => r.firstName === "Bo")?.emailOptedOut).toBe(true);
  });

  it("counts a refused attestation and the organiser's changes", async () => {
    const { app } = buildApp();
    const refused = () =>
      counterValue(CIRE_METRICS.guestEmailBlocked, { reason: "attestation_required" });
    const set = () =>
      counterValue(CIRE_METRICS.guestEmailChanged, { by: "organiser", action: "set" });
    const cleared = () =>
      counterValue(CIRE_METRICS.guestEmailChanged, { by: "organiser", action: "cleared" });
    const before = { refused: await refused(), set: await set(), cleared: await cleared() };
    const p = await preview(app, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: guestsCsv("ada@example.test", ""),
    });
    expect((await apply(app, p.changeId)).status).toBe(422);
    expect((await apply(app, p.changeId, ATTESTED)).status).toBe(200);
    expect(await refused()).toBe(before.refused + 1);
    expect(await set()).toBe(before.set + 1);
    expect(await cleared()).toBe(before.cleared);
    await change(app, { guestsCsv: guestsCsv("", "") });
    expect(await set()).toBe(before.set + 1);
    expect(await cleared()).toBe(before.cleared + 1);
  });
});

describe("more of what a revert restores", () => {
  it("restores a guest's own address an editor removed, as the guest's", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    guestGave(db, "Ada", "ada.own@example.test");
    const original = record(db, "Ada");
    const p = await editorChange(app, db, {
      Ada: { email: null, emailExpected: "ada.own@example.test" },
    });
    expect((await apply(app, p.changeId)).status).toBe(200);
    expect(record(db, "Ada")?.email).toBeNull();
    await revert(app, p.changeId);
    expect(record(db, "Ada")).toEqual(original);
  });

  it("restores an address a two-sheet change cleared", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const original = record(db, "Ada");
    const cleared = await change(app, { eventsCsv: EVENTS_CSV, guestsCsv: guestsCsv("", "") });
    expect(record(db, "Ada")?.email).toBeNull();
    await revert(app, cleared);
    expect(record(db, "Ada")).toEqual(original);
  });

  // Neither text that is not JSON nor JSON that is not a consent record is a
  // record: either way the address stays cleared, never restored on a source
  // nobody wrote.
  for (const [what, cell] of [
    ["is not JSON", '"{not json"'],
    [
      "names no known source",
      '"{""source"":""admin"",""consentAt"":0,""version"":""v"",""attestedBy"":null}"',
    ],
  ] as const) {
    it(`leaves an address cleared when the before-image's record ${what}`, async () => {
      const { db, r2, app } = buildApp();
      await seeded(app, "ada@example.test");
      const cleared = await change(app, { guestsCsv: guestsCsv("", "") });
      const [row] = db.select().from(imports).where(eq(imports.id, cleared)).all();
      const key = row!.beforeGuestsR2Key!;
      const csv = await (await r2.get(key))!.text();
      const tampered = csv.replace(/"\{[^\n]*\}"/, cell);
      expect(tampered).not.toBe(csv);
      await r2.put(key, tampered);
      await revert(app, cleared);
      expect(record(db, "Ada")?.email).toBeNull();
    });
  }

  it("leaves the live address when the before-image's cell is not an address", async () => {
    const { db, r2, app } = buildApp();
    await seeded(app, "");
    const added = await change(app, { guestsCsv: guestsCsv("ada@example.test", "") });
    const [row] = db.select().from(imports).where(eq(imports.id, added)).all();
    const key = row!.beforeGuestsR2Key!;
    const csv = await (await r2.get(key))!.text();
    const lines = csv.split("\r\n");
    const header = lines[0]!.split(",");
    const at = header.indexOf("Guest Email");
    const tampered = lines
      .map((line, i) => {
        if (i === 0 || !line.includes("Testfamily")) return line;
        const cells = line.split(",");
        cells[at] = "not-an-address";
        return cells.join(",");
      })
      .join("\r\n");
    expect(tampered).not.toBe(csv);
    await r2.put(key, tampered);
    await revert(app, added);
    expect(record(db, "Ada")?.email).toBe("ada@example.test");
  });

  // An organiser who no longer holds a seat (removed, or erased on request)
  // is not written back into a restored record.
  it("does not restore the attester of an organiser who no longer holds a seat", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    db.insert(weddingHosts)
      .values({
        id: "whost_email_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_email_editor",
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: new Date(),
      })
      .run();
    const editorBearer = await auth.sign("usr_email_editor");
    const asEditor = (path: string, body: object) =>
      appRequest(app, path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorBearer}` },
        body: JSON.stringify(body),
      });
    const pr = (await (
      await asEditor(`${CHANGES}/preview`, { guestsCsv: guestsCsv("ada@example.test", "") })
    ).json()) as Preview;
    expect(
      (await asEditor(`${CHANGES}/apply`, { changeId: pr.changeId, ...ATTESTED })).status,
    ).toBe(200);
    expect(record(db, "Ada")?.attestedBy).toBe("usr_email_editor");
    const cleared = await change(app, { guestsCsv: guestsCsv("", "") });
    db.delete(weddingHosts).where(eq(weddingHosts.id, "whost_email_editor")).run();
    await revert(app, cleared);
    expect(record(db, "Ada")).toMatchObject({
      email: "ada@example.test",
      source: "organiser_attested",
      attestedBy: null,
    });
  });
});

/**
 * A household session for `firstName`'s household that has said it is them,
 * as the invite opens one: claim the household's code, then choose the member.
 */
async function guestSession(app: App, db: TestDb, firstName: string) {
  const [row] = db
    .select({ id: guests.id, publicId: families.publicId })
    .from(guests)
    .innerJoin(families, eq(families.id, guests.familyId))
    .where(eq(guests.firstName, firstName))
    .all();
  if (!row) throw new Error(`no guest named ${firstName}`);
  const claimed = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId: row.publicId }),
  });
  expect(claimed.status).toBe(200);
  const cookie = `cire_session=${parseSessionToken(claimed.headers.get("Set-Cookie"))}`;
  const guestCall = (method: string, path: string, body: object) =>
    appRequest(app, path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  expect((await guestCall("POST", "/api/claim/member", { guestId: row.id })).status).toBe(200);
  return {
    /** The guest's own `PUT /api/claim/member/email`. */
    give: (email: string) =>
      guestCall("PUT", "/api/claim/member/email", {
        memberGuestId: row.id,
        email,
        consentVersion: GUEST_EMAIL_CONSENT.version,
      }),
    /** The guest's own `DELETE /api/claim/member/email`. */
    remove: () => guestCall("DELETE", "/api/claim/member/email", { memberGuestId: row.id }),
  };
}

// The organiser attests to the addresses the preview counted, with every
// withdrawal in view. A guest's own change does not move the wedding's head,
// so apply checks the set it would attest to against the preview's.
describe("apply attests only the addresses the preview showed", () => {
  it("refuses an address a guest withdrew after the preview, writing and checkpointing nothing", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const body = { guestsCsv: guestsCsv("ada@example.test", "bo@example.test") };
    // Ada's row already holds the sheet's address, so only Bo's is counted.
    const p = await preview(app, body);
    expect(p.emailAttestations).toBe(1);
    expect((await (await guestSession(app, db, "Ada")).remove()).status).toBe(200);

    const blocked = () =>
      counterValue(CIRE_METRICS.guestEmailBlocked, { reason: "attestation_stale" });
    const before = await blocked();
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await apply(app, p.changeId, ATTESTED);
    });
    expect(res?.status).toBe(409);
    expect(await jsonBody(res!)).toEqual({ error: "State changed — re-preview" });
    expect(await blocked()).toBe(before + 1);
    expect(logs).not.toContain("example.test");
    expect(record(db, "Ada")?.email).toBeNull();
    expect(record(db, "Bo")?.email).toBeNull();
    const [row] = db.select().from(imports).where(eq(imports.id, p.changeId)).all();
    expect(row?.status).toBe("preview");
    expect(row?.beforeGuestsR2Key).toBeNull();

    // A fresh preview counts the address and says the guest withdrew it.
    const again = await preview(app, body);
    expect(again.emailAttestations).toBe(2);
    expect(again.warnings.join(" ")).toContain("removed or replaced by the guest");
  });

  it("applies when a guest's change elsewhere leaves the attested addresses as they were", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    // Clears Ada's address, which needs no attestation, and sets Bo's.
    const p = await preview(app, { guestsCsv: guestsCsv("", "bo@example.test") });
    expect(p.emailAttestations).toBe(1);
    expect((await (await guestSession(app, db, "Ada")).remove()).status).toBe(200);

    expect((await apply(app, p.changeId, ATTESTED)).status).toBe(200);
    expect(record(db, "Ada")?.email).toBeNull();
    expect(record(db, "Bo")).toMatchObject({
      email: "bo@example.test",
      source: "organiser_attested",
      attestedBy: OWNER,
    });
  });

  it("refuses a change whose stored summary holds no record of the attested addresses", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const p = await preview(app, { guestsCsv: guestsCsv("", "bo@example.test") });
    db.update(imports)
      .set({ summary: sql`json_remove(${imports.summary}, '$.emailAttestationDigest')` })
      .where(eq(imports.id, p.changeId))
      .run();

    const res = await apply(app, p.changeId, ATTESTED);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "State changed — re-preview" });
    expect(record(db, "Bo")?.email).toBeNull();
  });

  it("keeps no address and no address hash in the change's summary", async () => {
    const { db, app } = buildApp();
    await seeded(app, "");
    const p = await preview(app, { guestsCsv: guestsCsv("", "bo@example.test") });
    const [row] = db.select().from(imports).where(eq(imports.id, p.changeId)).all();
    expect(row?.summary).toContain("emailAttestationDigest");
    expect(row?.summary).not.toContain("bo@example.test");
    expect(row?.summary).not.toContain(
      await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "bo@example.test"),
    );
  });
});

// A guest who replaces the address the hosts added has said it is wrong. A
// later sheet or revert holding the old address must not put it back unseen.
describe("an address a guest corrected away", () => {
  it("is warned about when a later sheet puts it back", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const ada = await guestSession(app, db, "Ada");
    expect((await ada.give("ada.real@example.test")).status).toBe(200);
    expect((await ada.remove()).status).toBe(200);

    const p = await preview(app, { guestsCsv: guestsCsv("ada@example.test", "") });
    expect(p.emailAttestations).toBe(1);
    expect(p.warnings.join(" ")).toContain("removed or replaced by the guest");
    expect(p.warnings.join(" ")).not.toContain("ada@example.test");
  });

  it("is not restored by a revert", async () => {
    const { db, app } = buildApp();
    await seeded(app, "ada@example.test");
    const unrelated = await change(app, {
      guestsCsv: guestsCsv("ada@example.test", "bo@example.test"),
    });
    const ada = await guestSession(app, db, "Ada");
    expect((await ada.give("ada.real@example.test")).status).toBe(200);
    expect((await ada.remove()).status).toBe(200);

    await revert(app, unrelated);
    expect(record(db, "Ada")?.email).toBeNull();
    expect(record(db, "Bo")?.email).toBeNull();
  });
});
