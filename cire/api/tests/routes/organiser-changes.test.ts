import { describe, it, expect, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guests,
  guestEvents,
  imports,
  organiserSessions,
  weddingEntitlements,
  weddingHosts,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import { organiserSessionService } from "../../src/services/organiser-session";
import { createR2Stub } from "../../src/services/r2-imports";
import { appRequest, jsonBody } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

let auth: OsnTestAuth;
let bearer: string;

const CHANGES_BASE = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/changes`;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
  bearer = await auth.sign("usr_dev_bootstrap_owner");
});

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Reception,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
].join("\n");

const GUESTS_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
  "1,Testfamily,Ada,Testfamily,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,yes",
].join("\n");

function buildApp() {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  const app = createApp(db, { r2, osnTestKey: auth.key });
  return { db, r2, app };
}

function ownerPost(app: ReturnType<typeof buildApp>["app"], path: string, body: object) {
  return appRequest(app, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function ownerGet(app: ReturnType<typeof buildApp>["app"], path: string) {
  return appRequest(app, path, { method: "GET", headers: { Authorization: `Bearer ${bearer}` } });
}

/** The head revision an editor reads before it loads the rows it seeds a draft from. */
async function headOf(app: ReturnType<typeof buildApp>["app"]): Promise<string> {
  const res = await ownerGet(app, `${CHANGES_BASE}/head`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { revision: string }).revision;
}

/**
 * POST an editor draft the way the editor does: stating `removeManual` and
 * carrying the head it was loaded at (read just now unless the body names one).
 */
async function editorPreview(app: ReturnType<typeof buildApp>["app"], body: object) {
  return ownerPost(app, `${CHANGES_BASE}/preview`, {
    removeManual: true,
    baseRevision: await headOf(app),
    ...body,
  });
}

// ── CSV front door through /changes ─────────────────────────────────────────

describe("POST /changes/preview + /apply — spreadsheet (CSV) front door", () => {
  it("previews then applies a CSV change, returning a baseRevision", async () => {
    const { app, db } = buildApp();

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      changeId: string;
      baseRevision: string;
      plan: { familyCreates: unknown[] };
    };
    // The alias-era `importId` echo is gone; `changeId` is the only id.
    expect(preview).not.toHaveProperty("importId");
    // Fresh wedding — no applied change yet, so the head is genesis.
    expect(preview.baseRevision).toBe("genesis");
    expect(preview.plan.familyCreates).toHaveLength(2);

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: preview.changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
  });
});

// ── Partial (single-sheet) uploads ──────────────────────────────────────────

/**
 * Either sheet may be uploaded on its own. The half that wasn't uploaded is NOT
 * part of the desired state, so it must survive untouched — the failure mode
 * these tests exist to prevent is "absent sheet" being read as "empty sheet",
 * which would reconcile by deleting every household (or every event).
 */
describe("POST /changes/preview + /apply — single-sheet uploads", () => {
  /** Seed the wedding with the full two-sheet import both partials build on. */
  async function seedBothSheets(app: ReturnType<typeof buildApp>["app"]) {
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };
    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
  }

  async function previewAndApply(
    app: ReturnType<typeof buildApp>["app"],
    body: Record<string, unknown>,
  ) {
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, body);
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      changeId: string;
      scope: string;
      plan: Record<string, unknown[]>;
    };
    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: preview.changeId });
    expect(applyRes.status).toBe(200);
    return { preview, summary: ((await applyRes.json()) as { summary: unknown }).summary };
  }

  // An events sheet that adds a third event and leaves the other two as they are.
  const EVENTS_ONLY_CSV = [
    "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
    "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
    "Reception,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
    "Sangeet,2026-09-19T18:00:00+10:00,2026-09-19T23:00:00+10:00,Australia/Sydney,Hall,,Festive,,,",
  ].join("\n");

  it("events-only: reconciles the schedule and leaves households, guests and their invites intact", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);
    const linksBefore = db.select().from(guestEvents).all().length;
    expect(linksBefore).toBeGreaterThan(0);

    const { preview } = await previewAndApply(app, { eventsCsv: EVENTS_ONLY_CSV });

    expect(preview.scope).toBe("events");
    // The guest half of the plan is empty by construction, not by coincidence.
    expect(preview.plan.familyRemoves).toHaveLength(0);
    expect(preview.plan.guestRemoves).toHaveLength(0);
    expect(preview.plan.familyCreates).toHaveLength(0);
    expect(preview.plan.eventCreates).toHaveLength(1);

    expect(db.select().from(events).all()).toHaveLength(3);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
    // Existing invitations survive an events-only upload untouched.
    expect(db.select().from(guestEvents).all()).toHaveLength(linksBefore);
  });

  it("guests-only: reconciles households against the EXISTING schedule, leaving events untouched", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);
    const eventIdsBefore = db
      .select()
      .from(events)
      .all()
      .map((e) => e.id)
      .toSorted();

    // A third guest joins Testfamily; Bo's Reception invite is withdrawn.
    const guestsOnlyCsv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
      "1,Testfamily,Ada,Testfamily,yes,yes",
      "1,Testfamily,Cy,Testfamily,yes,yes",
      "2,Sampleton,Bo,Sampleton,yes,no",
    ].join("\n");

    const { preview } = await previewAndApply(app, { guestsCsv: guestsOnlyCsv });

    expect(preview.scope).toBe("guests");
    // No event op at all — not even a no-op update that would bump updated_at.
    expect(preview.plan.eventCreates).toHaveLength(0);
    expect(preview.plan.eventUpdates).toHaveLength(0);
    expect(preview.plan.eventRemoves).toHaveLength(0);

    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.id)
        .toSorted(),
    ).toEqual(eventIdsBefore);
    expect(db.select().from(guests).all()).toHaveLength(3);
    // Bo keeps Mehndi (newly added) and loses Reception; Ada keeps both.
    const bo = db
      .select()
      .from(guests)
      .all()
      .find((g) => g.firstName === "Bo")!;
    expect(db.select().from(guestEvents).where(eq(guestEvents.guestId, bo.id)).all()).toHaveLength(
      1,
    );
  });

  it("events-only never removes households, even with the removeManual toggle on", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);

    // `removeManual` widens the guest half of the diff — but an events-only
    // upload has no guest half to widen, so households must still survive.
    await previewAndApply(app, { eventsCsv: EVENTS_ONLY_CSV, removeManual: true });

    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
  });

  it("a guests-only sheet naming an event that does not exist is a 422, not a silent drop", async () => {
    const { app } = buildApp();
    await seedBothSheets(app);

    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      guestsCsv: [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet",
        "1,Testfamily,Ada,Testfamily,yes,yes",
      ].join("\n"),
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string; column: string }).toMatchObject({
      error: "Unmatched event column",
      column: "Sangeet",
    });
  });

  it("400s a spreadsheet body carrying neither sheet", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, { removeManual: true });
    expect(res.status).toBe(400);
  });

  it("re-diffs at apply under the SAME scope the preview used", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_ONLY_CSV,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);

    // The apply path re-reads the stored sheets; the guests slot holds "" for an
    // events-only change, and scope — not the stored bytes — is what keeps that
    // from reconciling the guest list to nothing.
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
    expect(db.select().from(events).all()).toHaveLength(3);
  });

  it("a legacy row with no stored scope applies as 'both' (the safe default)", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };

    // Strip `scope` to reproduce a row previewed before this feature shipped and
    // applied after. The `?? "both"` default is otherwise never executed — every
    // row the new preview writes stamps a scope — so a broken read would be
    // invisible, and it fails in the destructive direction (a partial change
    // silently managing both halves).
    const [row] = db.select().from(imports).where(eq(imports.id, changeId)).all();
    const summary = JSON.parse(row!.summary) as Record<string, unknown>;
    delete summary.scope;
    db.update(imports)
      .set({ summary: JSON.stringify(summary) })
      .where(eq(imports.id, changeId))
      .run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("a guests-only apply re-reads the schedule LIVE, not from the preview snapshot", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);

    const guestsOnlyCsv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
      "1,Testfamily,Ada,Testfamily,yes,yes",
    ].join("\n");
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      guestsCsv: guestsOnlyCsv,
    });
    expect(previewRes.status).toBe(200);
    const { changeId } = (await previewRes.json()) as { changeId: string };

    // Drop an event between preview and apply, straight in the table. A write
    // outside the change pipeline doesn't move headRevision, so the 409
    // concurrency guard doesn't fire — the apply-time
    // re-hydration is the only thing standing between the sheet and a silently
    // dropped invitation. Asserting the located 422 is what distinguishes live
    // re-reading from replaying the preview's snapshot.
    const [mehndi] = db.select().from(events).where(eq(events.name, "Mehndi")).all();
    db.delete(events).where(eq(events.id, mehndi!.id)).run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(422);
    expect(await applyRes.json()).toMatchObject({
      error: "Unmatched event column",
      column: "Mehndi",
      sheet: "guests",
    });
  });

  it("a guests-only upload works on a wedding with no events yet", async () => {
    const { app } = buildApp();
    // No seedBothSheets — the schedule is empty, so the hydrated event list is
    // []. Mapping DB rows straight to ParsedEvent makes this a plain 200; the
    // old export→reparse route would have hinged on the exporter still emitting
    // a header row for zero events.
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      guestsCsv: [
        "Family ID,Family Name,Guest First Name,Guest Last Name",
        "1,Testfamily,Ada,Testfamily",
      ].join("\n"),
    });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as { scope: string; plan: Record<string, unknown[]> };
    expect(preview.scope).toBe("guests");
    expect(preview.plan.familyCreates).toHaveLength(1);
  });

  it("hydration tolerates live event rows the upload parser would reject", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);

    // The editor and the direct event routes never run the upload guards, so the
    // DB legitimately holds values `parseEventsCsv` would refuse: an address
    // starting `-` trips the formula-injection scan. Hydrating a guests-only
    // upload must not re-apply guards meant for untrusted files — otherwise this
    // 422s and blames an events sheet the organiser never uploaded.
    db.update(events).set({ address: "-12 Banksia Lane" }).where(eq(events.name, "Mehndi")).run();

    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      guestsCsv: [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
        "1,Testfamily,Ada,Testfamily,yes,yes",
      ].join("\n"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { scope: string }).toMatchObject({ scope: "guests" });
  });

  it("refuses a household-only row in an upload — only a revert reads those", async () => {
    const { app } = buildApp();
    await seedBothSheets(app);
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      guestsCsv: [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname,Mehndi,Reception,Family Code,Guest ID",
        "fam_empty,Emptyhouse,,,,,,EMPTY-0001,",
      ].join("\n"),
    });
    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toMatchObject({
      reason: "Guest First Name is required",
      sheet: "guests",
    });
  });

  it("reverts a single-sheet change from its (always full) before-image", async () => {
    const { app, db } = buildApp();
    await seedBothSheets(app);

    const { preview } = await previewAndApply(app, { eventsCsv: EVENTS_ONLY_CSV });
    expect(db.select().from(events).all()).toHaveLength(3);

    const revertRes = await ownerPost(app, `${CHANGES_BASE}/revert`, {
      changeId: preview.changeId,
    });
    expect(revertRes.status).toBe(200);
    // Back to the two seeded events, with the guest list still whole.
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
  });
});

// ── Parse-error reporting ───────────────────────────────────────────────────

/**
 * A 422 has to locate the problem: which sheet, which row, which column, and the
 * specific reason. Preview used to omit `column`, and apply used to return only
 * the top-level `error` — so the same bad file produced two different, equally
 * unactionable bodies and the portal had nothing to render but "Malformed
 * spreadsheet".
 */
describe("POST /changes/preview — parse errors locate the problem", () => {
  it("422s formula injection with cell coords and no cell contents", async () => {
    const { app } = buildApp();
    const evil = [
      "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
      "=cmd|',2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,",
    ].join("\n");

    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: evil,
      guestsCsv: GUESTS_CSV,
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.row).toBe(2);
    expect(body.column).toBe(1);
    // The offending cell is attacker-controlled — locate it, never echo it.
    expect(JSON.stringify(body)).not.toContain("cmd");
    expect(JSON.stringify(body)).not.toContain("=cmd");
  });

  it("reports reason + row + column + sheet for a bad timestamp", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: [
        "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
        // What Excel leaves behind after it "helpfully" reformats the cell.
        "Mehndi,18/09/2026 16:00,,Australia/Sydney,,,,,,",
      ].join("\n"),
    });

    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toEqual({
      error: "Malformed spreadsheet",
      reason: "Start must be an ISO-8601 timestamp",
      row: 2,
      column: 2,
      sheet: "events",
    });
  });

  it("says WHICH sheet failed when both were uploaded", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
        "1,Testfamily,,Testfamily,yes,yes",
      ].join("\n"),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      reason: "Guest First Name is required",
      sheet: "guests",
      row: 2,
    });
  });

  it("names the missing column and its sheet", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: ["Event Name,Start", "Mehndi,2026-09-18T16:00:00+10:00"].join("\n"),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "Missing required column",
      column: "Timezone",
      sheet: "events",
    });
  });

  it("accepts a sheet saved with a UTF-8 BOM (Excel's default)", async () => {
    const { app, db } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: `﻿${EVENTS_CSV}`,
    });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as { plan: { eventCreates: unknown[] } };
    expect(preview.plan.eventCreates).toHaveLength(2);
    expect(db.select().from(events).all()).toHaveLength(0);
  });

  it("reports null coordinates for a whole-file failure (no Error.column bleed)", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, { eventsCsv: "" });
    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toEqual({
      error: "Malformed spreadsheet",
      reason: "empty events sheet",
      row: null,
      column: null,
      sheet: "events",
    });
  });

  it("apply reports the same located body as preview, not a bare error", async () => {
    const { app, db, r2 } = buildApp();

    // Get a valid change row, then corrupt the stored sheet so the apply-time
    // re-parse (not the preview) is what fails — the path that used to return
    // `{error: "Malformed spreadsheet"}` and nothing else.
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, { eventsCsv: EVENTS_CSV });
    const { changeId } = (await previewRes.json()) as { changeId: string };
    const [row] = db.select().from(imports).where(eq(imports.id, changeId)).all();
    await r2.put(
      row!.eventsR2Key,
      [
        "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
        "Mehndi,18/09/2026 16:00,,Australia/Sydney,,,,,,",
      ].join("\n"),
    );

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(422);
    expect(await jsonBody(applyRes)).toEqual({
      error: "Malformed spreadsheet",
      reason: "Start must be an ISO-8601 timestamp",
      row: 2,
      column: 2,
      sheet: "events",
    });
  });
});

// ── DesiredState front door through /changes ────────────────────────────────

describe("POST /changes/preview + /apply — editor (DesiredState JSON) front door", () => {
  const desiredState = {
    events: [
      {
        name: "Mehndi",
        startAt: "2026-09-18T16:00:00+10:00",
        endAt: "",
        timezone: "Australia/Sydney",
        location: null,
        address: null,
        dressCodeDescription: null,
        dressCodePalette: [],
        pinterestUrl: null,
        mapsUrl: null,
        sortOrder: 0,
      },
    ],
    families: [
      {
        publicId: "EDIT-FAM-0001",
        familyName: "Editorhousehold",
        guests: [
          {
            firstName: "Nia",
            lastName: "Editorhousehold",
            nickname: null,
            eventNames: ["Mehndi"],
          },
        ],
      },
    ],
  };

  it("previews then applies an editor DesiredState draft", async () => {
    const { app, db } = buildApp();

    const previewRes = await editorPreview(app, { desiredState });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      changeId: string;
      plan: { warnings: unknown[] };
    };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: preview.changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(1);
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);

    // The change is recorded as an EDITOR save in the history.
    const listRes = await ownerGet(app, `${CHANGES_BASE}/list`);
    const list = (await listRes.json()) as { imports: Array<{ kind: string; status: string }> };
    expect(list.imports[0]!.kind).toBe("editor");
    expect(list.imports[0]!.status).toBe("applied");
  });

  it("editor DesiredState manages everything shown — removes a household not in the draft", async () => {
    const { app, db } = buildApp();

    // First seed two households via a CSV import.
    const seed = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId: ((await seed.json()) as { changeId: string }).changeId,
    });
    expect(db.select().from(families).all()).toHaveLength(2);

    // Now an editor save that shows only ONE household (the draft is the whole
    // truth) → the other imported household must be removed even though it is
    // source='import' and absent (removeManual is implicit for the editor).
    const preview = await editorPreview(app, { desiredState });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId: ((await preview.json()) as { changeId: string }).changeId,
    });

    const remaining = db.select().from(families).all();
    expect(remaining.map((f) => f.familyName)).toEqual(["Editorhousehold"]);
  });

  it("rejects a blank household name at the schema boundary (400, S-L2)", async () => {
    // The editor client validates non-blank names, but the client is not a
    // security boundary — the DesiredState JSON front door used to accept a
    // blank (or unbounded) familyName straight through to rows the guest
    // invite renders. The schema refinement now 400s it before any diff runs.
    const { app } = buildApp();
    const blankName = {
      ...desiredState,
      families: [{ ...desiredState.families[0]!, familyName: "   " }],
    };
    const res = await editorPreview(app, { desiredState: blankName });
    expect(res.status).toBe(400);
  });

  it("saves a HOUSEHOLD NAME edit — id-matched rename writes through, code + guests survive", async () => {
    const { app, db } = buildApp();

    // Seed through the editor front door, then read back what a draft loads.
    const seed = await editorPreview(app, { desiredState });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId: ((await seed.json()) as { changeId: string }).changeId,
    });
    const before = db.select().from(families).all()[0]!;
    const guestBefore = db.select().from(guests).all()[0]!;

    // The draft the editor posts after typing a new household name: same ids,
    // new familyName. This used to preview as an all-zero plan and apply as a
    // no-op — the "household name won't save" bug.
    const renamedState = {
      ...desiredState,
      families: [
        {
          id: before.id,
          publicId: before.publicId,
          familyName: "Editor-Renamed Household",
          guests: [
            {
              id: guestBefore.id,
              firstName: guestBefore.firstName,
              lastName: guestBefore.lastName,
              nickname: null,
              eventNames: ["Mehndi"],
            },
          ],
        },
      ],
    };
    const preview = await editorPreview(app, {
      desiredState: renamedState,
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      changeId: string;
      plan: { familyUpdates: unknown[]; familyCreates: unknown[]; familyRemoves: unknown[] };
    };
    expect(previewBody.plan.familyUpdates).toHaveLength(1);
    expect(previewBody.plan.familyCreates).toHaveLength(0);
    expect(previewBody.plan.familyRemoves).toHaveLength(0);

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId: previewBody.changeId,
    });
    expect(applyRes.status).toBe(200);

    const after = db.select().from(families).all()[0]!;
    expect(after.id).toBe(before.id);
    expect(after.familyName).toBe("Editor-Renamed Household");
    // The claim code and the guest row both survive the rename untouched.
    expect(after.publicId).toBe(before.publicId);
    expect(db.select().from(guests).all()[0]!.id).toBe(guestBefore.id);
  });

  it("409s an editor row whose stored scope is missing, rather than widening it to 'both'", async () => {
    const { app, db } = buildApp();

    // Seed a household through the editor, so there is something a widened
    // scope could destroy.
    const seed = await editorPreview(app, { desiredState });
    const seedId = ((await seed.json()) as { changeId: string }).changeId;
    expect((await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: seedId })).status).toBe(200);
    expect(db.select().from(families).all()).toHaveLength(1);

    // An events-only save: the events editor carries no households at all.
    const previewRes = await editorPreview(app, {
      desiredState: { events: desiredState.events, families: [] },
      scope: "events",
    });
    expect(previewRes.status).toBe(200);
    const { changeId } = (await previewRes.json()) as { changeId: string };

    // Reproduce a row previewed before this feature shipped. For a SHEET the
    // `"both"` fallback is harmless, but an editor row pairs an empty family
    // list with `removeManual: true` and `matchByName: false`, so managing the
    // guest half would remove every household and cascade its guests, RSVPs and
    // claim codes. There is no safe value to guess, so the apply is refused.
    const [row] = db.select().from(imports).where(eq(imports.id, changeId)).all();
    const summary = JSON.parse(row!.summary) as Record<string, unknown>;
    delete summary.scope;
    db.update(imports)
      .set({ summary: JSON.stringify(summary) })
      .where(eq(imports.id, changeId))
      .run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(409);
    // Pin the message, not just the code: this route's other 409 says the state
    // changed under the organiser, and that one is fixed by reloading. This one
    // is only fixed by previewing again, and the editor shows the text verbatim.
    expect((await applyRes.json()) as { error: string }).toEqual({
      error: "Change is missing its scope — re-preview",
    });
    // The household is still there, with its claim code intact.
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);
  });

  it("409s an editor row whose stored scope is present but undecodable, same as a missing one", async () => {
    const { app, db } = buildApp();

    // Seed a household through the editor, so there is something a widened
    // scope could destroy.
    const seed = await editorPreview(app, { desiredState });
    const seedId = ((await seed.json()) as { changeId: string }).changeId;
    expect((await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: seedId })).status).toBe(200);
    expect(db.select().from(families).all()).toHaveLength(1);

    // An events-only save: the events editor carries no households at all.
    const previewRes = await editorPreview(app, {
      desiredState: { events: desiredState.events, families: [] },
      scope: "events",
    });
    expect(previewRes.status).toBe(200);
    const { changeId } = (await previewRes.json()) as { changeId: string };

    // Unlike the test above, `scope` is not ABSENT here — it is PRESENT and
    // corrupt (a truncated write, a botched migration, a hand-edited summary).
    // `Schema.decodeUnknownOption(ChangeScope)` rejects it the same way it
    // rejects a missing key, and the guard has to treat both as "undecodable":
    // a check for `stored.scope === undefined` would let this value fall
    // through to the `"both"` default and remove every household.
    const [row] = db.select().from(imports).where(eq(imports.id, changeId)).all();
    const summary = JSON.parse(row!.summary) as Record<string, unknown>;
    summary.scope = "everything";
    db.update(imports)
      .set({ summary: JSON.stringify(summary) })
      .where(eq(imports.id, changeId))
      .run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(409);
    expect((await applyRes.json()) as { error: string }).toEqual({
      error: "Change is missing its scope — re-preview",
    });
    // The household and its guest survive, same as the missing-scope case.
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);
  });

  it("keeps the 'both' fallback for a SHEET row whose stored scope is missing", async () => {
    const { app, db } = buildApp();

    // The refusal above is deliberately narrow: only an editor row is unsafe to
    // guess at, because only an editor row pairs an empty half with the
    // authority to delete it. A spreadsheet upload states each sheet it manages
    // by uploading it, so `"both"` costs it nothing — and rows previewed before
    // this feature shipped must still apply rather than dead-ending at a 409.
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    expect(previewRes.status).toBe(200);
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const [row] = db.select().from(imports).where(eq(imports.id, changeId)).all();
    const summary = JSON.parse(row!.summary) as Record<string, unknown>;
    delete summary.scope;
    db.update(imports)
      .set({ summary: JSON.stringify(summary) })
      .where(eq(imports.id, changeId))
      .run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
    // Both sheets reconciled, which is what `"both"` means.
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("400s a body carrying BOTH front doors' fields", async () => {
    const { app } = buildApp();

    // A union member that fails falls through to the next, and the two doors
    // apply opposite diff options (`removeManual`/`matchByName`). So a body
    // holding both would be decided by whether its `desiredState` happened to
    // parse — a draft with one bad field silently becoming a spreadsheet import
    // of whatever CSV rode along. Neither reading is more likely right.
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      desiredState,
      eventsCsv: EVENTS_CSV,
    });
    expect(res.status).toBe(400);
    // The decode refused it. A 400 carrying anything else would mean some other
    // guard tripped first and the union fallthrough is still open behind it.
    expect((await res.json()) as { error: string }).toEqual({ error: "Missing or invalid fields" });
  });

  /**
   * The editor expresses a deletion by ABSENCE — it posts the whole draft and
   * the dropped row simply isn't in it. These walk the two shapes that used to
   * swallow that: a guest whose first name collides with a sibling's (invisible
   * to the removal scan) and a replacement guest reusing a deleted guest's name
   * (which adopted the deleted row instead of replacing it). Both ended the same
   * way for the organiser: apply succeeds, and the guest is back on reload.
   */
  describe("deleting a guest", () => {
    /** Seed a household straight through the editor front door, then read back
     *  the ids a real draft would have loaded. */
    async function seedHousehold(
      app: ReturnType<typeof buildApp>["app"],
      db: ReturnType<typeof buildApp>["db"],
      members: { firstName: string; lastName: string }[],
    ) {
      const seedState = {
        ...desiredState,
        families: [
          {
            publicId: "EDIT-FAM-0001",
            familyName: "Editorhousehold",
            guests: members.map((m) => ({
              firstName: m.firstName,
              lastName: m.lastName,
              nickname: null,
              eventNames: ["Mehndi"],
            })),
          },
        ],
      };
      const preview = await editorPreview(app, { desiredState: seedState });
      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, {
        changeId: ((await preview.json()) as { changeId: string }).changeId,
      });
      expect(applyRes.status).toBe(200);
      return {
        family: db.select().from(families).all()[0]!,
        guestRows: db.select().from(guests).all(),
        event: db.select().from(events).all()[0]!,
      };
    }

    /** The draft the editor would post back: the loaded rows, minus `drop`. */
    function draftWithout(
      family: { id: string; publicId: string; familyName: string },
      guestRows: { id: string; firstName: string; lastName: string }[],
      drop: (g: { id: string }) => boolean,
      add: { firstName: string; lastName: string }[] = [],
    ) {
      return {
        ...desiredState,
        families: [
          {
            id: family.id,
            publicId: family.publicId,
            familyName: family.familyName,
            guests: [
              ...guestRows
                .filter((g) => !drop(g))
                .map((g) => ({
                  id: g.id,
                  firstName: g.firstName,
                  lastName: g.lastName,
                  nickname: null,
                  eventNames: ["Mehndi"],
                })),
              ...add.map((a) => ({ ...a, nickname: null, eventNames: ["Mehndi"] })),
            ],
          },
        ],
      };
    }

    it("removes a guest whose first name collides with a sibling's", async () => {
      const { app, db } = buildApp();
      const { family, guestRows } = await seedHousehold(app, db, [
        { firstName: "Sam", lastName: "Editorhousehold" },
        { firstName: "sam ", lastName: "Lee" },
      ]);
      expect(guestRows).toHaveLength(2);
      const doomed = guestRows.find((g) => g.lastName === "Editorhousehold")!;

      const preview = await editorPreview(app, {
        desiredState: draftWithout(family, guestRows, (g) => g.id === doomed.id),
      });
      const { changeId, plan } = (await preview.json()) as {
        changeId: string;
        plan: { guestRemoves: { id: string }[] };
      };
      expect(plan.guestRemoves.map((g) => g.id)).toEqual([doomed.id]);

      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
      expect(applyRes.status).toBe(200);
      expect(
        db
          .select()
          .from(guests)
          .all()
          .map((g) => g.lastName),
      ).toEqual(["Lee"]);
    });

    it("removes a guest even when a new guest reuses their first name", async () => {
      const { app, db } = buildApp();
      const { family, guestRows } = await seedHousehold(app, db, [
        { firstName: "Nia", lastName: "Editorhousehold" },
        { firstName: "Bo", lastName: "Editorhousehold" },
      ]);
      const doomed = guestRows.find((g) => g.firstName === "Bo")!;

      const preview = await editorPreview(app, {
        desiredState: draftWithout(family, guestRows, (g) => g.id === doomed.id, [
          { firstName: "Bo", lastName: "Newcomer" },
        ]),
      });
      const { changeId, plan } = (await preview.json()) as {
        changeId: string;
        plan: { guestRemoves: { id: string }[]; guestCreates: unknown[] };
      };
      expect(plan.guestRemoves.map((g) => g.id)).toEqual([doomed.id]);
      expect(plan.guestCreates).toHaveLength(1);

      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
      expect(applyRes.status).toBe(200);
      const after = db.select().from(guests).all();
      // The old "Bo" is gone — the new one is a different row entirely.
      expect(after.some((g) => g.id === doomed.id)).toBe(false);
      expect(after.map((g) => g.lastName).toSorted()).toEqual(["Editorhousehold", "Newcomer"]);
    });

    it("keeps the deletion when apply re-diffs from the stored draft", async () => {
      const { app, db } = buildApp();
      const { family, guestRows } = await seedHousehold(app, db, [
        { firstName: "Nia", lastName: "Editorhousehold" },
        { firstName: "Bo", lastName: "Editorhousehold" },
      ]);
      const doomed = guestRows.find((g) => g.firstName === "Bo")!;

      // Apply re-derives the desired state from R2 and re-diffs against live
      // state, so the id-authoritative matching has to survive that round trip
      // (it is read back off the change row, not re-decided from the request).
      const preview = await editorPreview(app, {
        desiredState: draftWithout(family, guestRows, (g) => g.id === doomed.id, [
          { firstName: "Bo", lastName: "Newcomer" },
        ]),
      });
      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, {
        changeId: ((await preview.json()) as { changeId: string }).changeId,
      });
      expect(applyRes.status).toBe(200);
      expect(
        db
          .select()
          .from(guests)
          .all()
          .some((g) => g.id === doomed.id),
      ).toBe(false);
    });

    /**
     * Apply re-reads `matchByName` off the persisted summary. A change previewed
     * BEFORE this branch ships and applied after has no such field, so the
     * fallback (`row.kind !== "editor"`) is the only thing deciding it — and it
     * decides in both directions. Backwards, a pending editor change applies with
     * name matching ON and swallows exactly the deletions this branch fixes; a
     * pending import applies id-authoritatively and turns a routine re-upload into
     * a mass remove+create of the whole roster.
     */
    it("derives matchByName from `kind` when the summary predates the field", async () => {
      const { app, db } = buildApp();
      const { family, guestRows } = await seedHousehold(app, db, [
        { firstName: "Nia", lastName: "Editorhousehold" },
        { firstName: "Bo", lastName: "Editorhousehold" },
      ]);
      const doomed = guestRows.find((g) => g.firstName === "Bo")!;

      const preview = await editorPreview(app, {
        desiredState: draftWithout(family, guestRows, (g) => g.id === doomed.id, [
          { firstName: "Bo", lastName: "Newcomer" },
        ]),
      });
      const { changeId } = (await preview.json()) as { changeId: string };

      // Rewrite the stored summary into its pre-branch shape.
      const row = db.select().from(imports).where(eq(imports.id, changeId)).all()[0]!;
      const legacy = JSON.parse(row.summary) as Record<string, unknown>;
      delete legacy.matchByName;
      db.update(imports)
        .set({ summary: JSON.stringify(legacy) })
        .where(eq(imports.id, changeId))
        .run();

      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
      expect(applyRes.status).toBe(200);
      // kind = 'editor' ⇒ id-authoritative ⇒ the deletion still lands.
      expect(
        db
          .select()
          .from(guests)
          .all()
          .some((g) => g.id === doomed.id),
      ).toBe(false);
    });

    it("a legacy summary on an IMPORT change still matches by name", async () => {
      const { app, db } = buildApp();
      await ownerPost(app, `${CHANGES_BASE}/preview`, {
        eventsCsv: EVENTS_CSV,
        guestsCsv: GUESTS_CSV,
      }).then(async (r) =>
        ownerPost(app, `${CHANGES_BASE}/apply`, {
          changeId: ((await r.json()) as { changeId: string }).changeId,
        }),
      );
      const before = db.select().from(guests).all();

      // The same sheet again — a re-upload, which must be a fixpoint.
      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
        eventsCsv: EVENTS_CSV,
        guestsCsv: GUESTS_CSV,
      });
      const { changeId } = (await preview.json()) as { changeId: string };
      const row = db.select().from(imports).where(eq(imports.id, changeId)).all()[0]!;
      const legacy = JSON.parse(row.summary) as Record<string, unknown>;
      delete legacy.matchByName;
      db.update(imports)
        .set({ summary: JSON.stringify(legacy) })
        .where(eq(imports.id, changeId))
        .run();

      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
      expect(applyRes.status).toBe(200);
      // Same rows, same ids — not a remove+create of the whole roster.
      expect(
        db
          .select()
          .from(guests)
          .all()
          .map((g) => g.id)
          .toSorted(),
      ).toEqual(before.map((g) => g.id).toSorted());
    });

    /**
     * `baseRevision` guards preview→apply; nothing guarded LOAD→preview. With no
     * name fallback, a draft row whose id has since been deleted would reconcile
     * as remove+create — dropping RSVPs and re-minting a claim code — so the diff
     * refuses it outright.
     */
    it("409s a draft naming a guest that no longer exists", async () => {
      const { app, db } = buildApp();
      const { family, guestRows } = await seedHousehold(app, db, [
        { firstName: "Nia", lastName: "Editorhousehold" },
        { firstName: "Bo", lastName: "Editorhousehold" },
      ]);

      // A co-host deletes Bo out from under the open editor.
      const gone = guestRows.find((g) => g.firstName === "Bo")!;
      db.delete(guests).where(eq(guests.id, gone.id)).run();

      // The draft still lists Bo, with its id — the shape a stale editor posts.
      const res = await editorPreview(app, {
        desiredState: draftWithout(family, guestRows, () => false),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.reason).toBe("stale_draft");
      // Nothing was written, and the surviving guest is untouched.
      expect(db.select().from(guests).all()).toHaveLength(1);
    });

    it("leaves a guest-less household alone — the editor carries it in the draft", async () => {
      const { app, db } = buildApp();
      const { family, guestRows } = await seedHousehold(app, db, [
        { firstName: "Nia", lastName: "Editorhousehold" },
      ]);

      // Empty the household but keep it in the draft (what the editor now posts
      // once households load separately from guests).
      const preview = await editorPreview(app, {
        desiredState: draftWithout(family, guestRows, () => true),
      });
      const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, {
        changeId: ((await preview.json()) as { changeId: string }).changeId,
      });
      expect(applyRes.status).toBe(200);
      expect(db.select().from(guests).all()).toHaveLength(0);
      // The household — and its claim code — survive.
      const remaining = db.select().from(families).all();
      expect(remaining.map((f) => f.id)).toEqual([family.id]);
      expect(remaining[0]!.publicId).toBe(family.publicId);
    });
  });
});

// ── Optimistic concurrency: 409 on stale baseRevision ───────────────────────

describe("POST /changes/apply — 409 on stale baseRevision", () => {
  it("409s a preview whose baseRevision moved (a concurrent apply landed)", async () => {
    const { app } = buildApp();

    // Preview A at genesis.
    const previewA = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const idA = ((await previewA.json()) as { changeId: string }).changeId;

    // Preview B ALSO at genesis, then apply B — this advances the head.
    const previewB = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const idB = ((await previewB.json()) as { changeId: string }).changeId;
    const applyB = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: idB });
    expect(applyB.status).toBe(200);

    // Applying A now must 409 — the wedding changed under it since preview.
    const applyA = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: idA });
    expect(applyA.status).toBe(409);
    const body = (await applyA.json()) as {
      error: string;
      baseRevision: string;
      currentRevision: string;
    };
    expect(body.error).toBe("State changed — re-preview");
    // A preview at genesis, a head that has since moved to B's commit.
    expect(body.baseRevision).toBe("genesis");
    expect(body.currentRevision).not.toBe("genesis");
    expect(body.currentRevision).toBe(await headOf(app));
  });

  it("does NOT 409 when only a second preview (no apply) intervened", async () => {
    const { app } = buildApp();
    const previewA = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const idA = ((await previewA.json()) as { changeId: string }).changeId;
    // A second preview mutates nothing (status stays 'preview'), so the head is
    // unchanged and A still applies.
    await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const applyA = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: idA });
    expect(applyA.status).toBe(200);
  });
});

// ── Editor drafts: load-time revision, scope, emptied halves ────────────────

/** Seed the wedding with the two-sheet import (2 events, 2 households). */
async function seedSheets(app: ReturnType<typeof buildApp>["app"]) {
  const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
    eventsCsv: EVENTS_CSV,
    guestsCsv: GUESTS_CSV,
  });
  const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, {
    changeId: ((await preview.json()) as { changeId: string }).changeId,
  });
  expect(applyRes.status).toBe(200);
}

/**
 * The DesiredState an editor would build from the wedding's rows as they are
 * now — every row with its id, attendance by event name.
 */
function draftFromDb(db: ReturnType<typeof buildApp>["db"]) {
  const eventRows = db
    .select()
    .from(events)
    .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
    .all();
  const familyRows = db
    .select()
    .from(families)
    .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
    .all()
    .filter((f) => f.kind !== "host");
  const guestRows = db.select().from(guests).all();
  const links = db.select().from(guestEvents).all();
  const eventName = new Map(eventRows.map((e) => [e.id, e.name]));
  return {
    events: eventRows.map((e) => ({
      id: e.id,
      name: e.name,
      startAt: e.startAt,
      endAt: e.endAt,
      timezone: e.timezone,
      location: null,
      address: e.address,
      dressCodeDescription: e.dressCodeDescription,
      dressCodePalette: [],
      pinterestUrl: e.pinterestUrl,
      mapsUrl: e.mapsUrl,
      sortOrder: e.sortOrder,
    })),
    families: familyRows.map((f) => ({
      id: f.id,
      publicId: f.publicId,
      familyName: f.familyName,
      guests: guestRows
        .filter((g) => g.familyId === f.id)
        .map((g) => ({
          id: g.id,
          firstName: g.firstName,
          lastName: g.lastName,
          nickname: g.nickname,
          eventNames: links.filter((l) => l.guestId === g.id).map((l) => eventName.get(l.eventId)!),
        })),
    })),
  };
}

async function applyChange(app: ReturnType<typeof buildApp>["app"], preview: Response) {
  expect(preview.status).toBe(200);
  const { changeId } = (await preview.json()) as { changeId: string };
  const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
  expect(applyRes.status).toBe(200);
}

describe("GET /changes/head", () => {
  it("is genesis on a wedding with no committed change, and uncacheable", async () => {
    const { app } = buildApp();
    const res = await ownerGet(app, `${CHANGES_BASE}/head`);
    expect(res.status).toBe(200);
    // A cached copy would pin an editor to a stale revision.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await jsonBody(res)).toEqual({ revision: "genesis" });
  });

  it("moves when a change is applied, and again when it is reverted", async () => {
    const { app } = buildApp();
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId, baseRevision } = (await preview.json()) as {
      changeId: string;
      baseRevision: string;
    };
    expect(await headOf(app)).toBe(baseRevision);

    await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    const afterApply = await headOf(app);
    expect(afterApply).not.toBe(baseRevision);

    // Reverting the newest change keeps it the newest row — the head still has
    // to move, because the wedding did.
    await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId });
    expect(await headOf(app)).not.toBe(afterApply);
  });

  it("401 with no credential at all", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${CHANGES_BASE}/head`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("403 for a signed-in stranger, 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const stranger = await appRequest(app, `${CHANGES_BASE}/head`, {
      method: "GET",
      headers: { Authorization: `Bearer ${await auth.sign("usr_not_a_member")}` },
    });
    expect(stranger.status).toBe(403);
    expect(await jsonBody(stranger)).toEqual({ error: "forbidden" });

    const unknown = await ownerGet(app, "/api/organiser/weddings/wed_nope/changes/head");
    expect(unknown.status).toBe(404);
  });

  it("serves the organiser's session cookie — the way the browser calls it", async () => {
    const { app, db } = buildApp();
    const { token } = await Effect.runPromise(
      organiserSessionService
        .create({
          osnProfileId: "usr_dev_bootstrap_owner",
          osnSub: "pw_owner",
          email: "owner@example.test",
          handle: "owner",
          displayName: "Owner",
          avatarUrl: null,
        })
        .pipe(Effect.provideService(DbService, db)),
    );
    const res = await appRequest(app, `${CHANGES_BASE}/head`, {
      method: "GET",
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ revision: "genesis" });

    const forged = await appRequest(app, `${CHANGES_BASE}/head`, {
      method: "GET",
      headers: { cookie: "cire_org_session=nosuchtoken" },
    });
    expect(forged.status).toBe(401);
  });

  it("is per wedding — another wedding's change does not move it", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const before = await headOf(app);
    db.insert(weddings)
      .values({
        id: "wed_other_head",
        slug: "other-head",
        displayName: "Other",
        ownerOsnProfileId: "usr_other_owner",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    db.insert(imports)
      .values({
        id: "chg_other_wedding",
        weddingId: "wed_other_head",
        uploadedAt: Date.now(),
        format: "csv",
        eventsR2Key: "k",
        guestsR2Key: "k",
        summary: "{}",
        status: "applied",
        appliedAt: Date.now(),
      })
      .run();
    expect(await headOf(app)).toBe(before);
  });

  it("403 read_only_role for a viewer co-host", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_head_viewer",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_head_viewer",
        addedByOsnProfileId: "usr_dev_bootstrap_owner",
        role: "viewer",
        createdAt: new Date(),
      })
      .run();
    const res = await appRequest(app, `${CHANGES_BASE}/head`, {
      method: "GET",
      headers: { Authorization: `Bearer ${await auth.sign("usr_head_viewer")}` },
    });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "read_only_role" });
  });
});

/**
 * The editor seeds its draft once, at load, and the editor door reads every
 * row the draft lacks as a removal. A change committed after that load is
 * absent from the draft without the organiser having removed anything, so the
 * draft has to name the revision it was loaded at and be refused once the head
 * has moved.
 */
describe("POST /changes/preview — an editor draft is only as current as its load", () => {
  it("refuses a draft loaded before a co-host added a household, and removes nothing", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);

    // The organiser opens the editor: the head first, then the rows.
    const loadedAt = await headOf(app);
    const draft = draftFromDb(db);

    // A co-host adds a household and saves.
    const cohostDraft = draftFromDb(db);
    await applyChange(
      app,
      await editorPreview(app, {
        desiredState: {
          ...cohostDraft,
          families: [...cohostDraft.families, { familyName: "Cohostadded", guests: [] }],
        },
        scope: "guests",
      }),
    );
    expect(db.select().from(families).all()).toHaveLength(3);

    // The organiser's draft never saw it. Previewed as-is it is refused.
    const stale = await editorPreview(app, {
      desiredState: draft,
      scope: "guests",
      baseRevision: loadedAt,
    });
    expect(stale.status).toBe(409);
    expect(await jsonBody(stale)).toEqual({
      error: "State changed — reload the editor",
      reason: "stale_draft",
    });
    // Nothing stored, nothing removed.
    expect(db.select().from(families).all()).toHaveLength(3);
    expect(
      db
        .select()
        .from(imports)
        .all()
        .filter((r) => r.status === "preview"),
    ).toHaveLength(0);

    // The same draft stamped with the current head would have planned the
    // co-host's household away — which is the loss the refusal prevents.
    const fresh = await editorPreview(app, { desiredState: draft, scope: "guests" });
    const { plan } = (await fresh.json()) as {
      plan: { familyRemoves: { familyName: string }[] };
    };
    expect(plan.familyRemoves.map((f) => f.familyName)).toEqual(["Cohostadded"]);
  });

  it("refuses a draft loaded before a revert brought a household back", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);

    // Change 2 removes Sampleton.
    const withBoth = draftFromDb(db);
    const removal = await editorPreview(app, {
      desiredState: {
        ...withBoth,
        families: withBoth.families.filter((f) => f.familyName !== "Sampleton"),
      },
      scope: "guests",
    });
    const removalId = ((await removal.clone().json()) as { changeId: string }).changeId;
    await applyChange(app, removal);
    expect(db.select().from(families).all()).toHaveLength(1);

    // The organiser opens the editor on the one remaining household.
    const loadedAt = await headOf(app);
    const draft = draftFromDb(db);

    // A co-host reverts change 2: Sampleton is back.
    const revert = await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId: removalId });
    expect(revert.status).toBe(200);
    expect(db.select().from(families).all()).toHaveLength(2);

    const stale = await editorPreview(app, {
      desiredState: draft,
      scope: "guests",
      baseRevision: loadedAt,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { reason: string }).reason).toBe("stale_draft");
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("400s an editor draft that carries no base revision", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      desiredState: draftFromDb(db),
      scope: "guests",
      removeManual: true,
    });
    expect(res.status).toBe(400);
  });

  it("400s an editor draft that does not state removeManual", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      desiredState: draftFromDb(db),
      scope: "guests",
      baseRevision: await headOf(app),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /changes/preview — a guests-scoped editor save leaves the schedule alone", () => {
  it("emits no event operation even when the draft's event list is empty", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const eventsBefore = db.select().from(events).all();

    // Rename a guest; carry no events at all.
    const draft = draftFromDb(db);
    draft.families[0]!.guests[0]!.lastName = "Renamed";
    const preview = await editorPreview(app, {
      desiredState: { events: [], families: draft.families },
      scope: "guests",
    });
    expect(preview.status).toBe(200);
    const body = (await preview.clone().json()) as {
      scope: string;
      clears: unknown;
      plan: {
        eventCreates: unknown[];
        eventUpdates: unknown[];
        eventRemoves: unknown[];
        guestUpdates: unknown[];
        eventLinkRemoves: unknown[];
      };
    };
    expect(body.scope).toBe("guests");
    expect(body.plan.eventCreates).toHaveLength(0);
    expect(body.plan.eventUpdates).toHaveLength(0);
    expect(body.plan.eventRemoves).toHaveLength(0);
    // Attendance resolved against the live schedule: no invitation dropped.
    expect(body.plan.eventLinkRemoves).toHaveLength(0);
    expect(body.plan.guestUpdates).toHaveLength(1);
    expect(body.clears).toBeNull();

    await applyChange(app, preview);
    expect(db.select().from(events).all()).toEqual(eventsBefore);
    expect(db.select().from(guestEvents).all()).toHaveLength(3);
  });

  it("refuses a draft whose event was renamed since it loaded, rather than dropping its invitations", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const draft = draftFromDb(db);

    // A write that does not go through the change pipeline, so the head stays
    // put — the row-level check is what has to catch it.
    const [mehndi] = db.select().from(events).where(eq(events.name, "Mehndi")).all();
    db.update(events).set({ name: "Henna" }).where(eq(events.id, mehndi!.id)).run();

    const res = await editorPreview(app, { desiredState: draft, scope: "guests" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("stale_draft");
    expect(db.select().from(guestEvents).all()).toHaveLength(3);
  });

  it("refuses a draft whose two events swapped names since it loaded", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const draft = draftFromDb(db);
    const linksBefore = db
      .select()
      .from(guestEvents)
      .all()
      .map((l) => `${l.guestId}::${l.eventId}`)
      .toSorted();

    // Every name the draft holds still resolves — to the other event. Only the
    // id-and-name check on the draft's events can see that.
    const [mehndi] = db.select().from(events).where(eq(events.name, "Mehndi")).all();
    const [reception] = db.select().from(events).where(eq(events.name, "Reception")).all();
    db.update(events).set({ name: "Swap" }).where(eq(events.id, mehndi!.id)).run();
    db.update(events).set({ name: "Mehndi" }).where(eq(events.id, reception!.id)).run();
    db.update(events).set({ name: "Reception" }).where(eq(events.id, mehndi!.id)).run();

    const res = await editorPreview(app, { desiredState: draft, scope: "guests" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("stale_draft");
    expect(
      db
        .select()
        .from(guestEvents)
        .all()
        .map((l) => `${l.guestId}::${l.eventId}`)
        .toSorted(),
    ).toEqual(linksBefore);
  });

  it("refuses a draft carrying an event that has since been deleted", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const draft = draftFromDb(db);
    // Nobody in the draft attends Mehndi, so no attendance name goes missing:
    // only the draft's own event list shows it is out of date.
    for (const family of draft.families) {
      for (const guest of family.guests) {
        guest.eventNames = guest.eventNames.filter((n) => n !== "Mehndi");
      }
    }
    const [mehndi] = db.select().from(events).where(eq(events.name, "Mehndi")).all();
    db.delete(guestEvents).where(eq(guestEvents.eventId, mehndi!.id)).run();
    db.delete(events).where(eq(events.id, mehndi!.id)).run();

    const res = await editorPreview(app, { desiredState: draft, scope: "guests" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("stale_draft");
  });

  it("refuses attendance naming an event that no longer exists", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const draft = draftFromDb(db);
    draft.families[0]!.guests[0]!.eventNames = ["Mehndi", "Afterparty"];

    const res = await editorPreview(app, {
      desiredState: { events: [], families: draft.families },
      scope: "guests",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("stale_draft");
  });
});

/**
 * An editor draft with an empty half is a legitimate "remove them all" — and
 * also exactly what a client that seeded a slice from nothing would post. The
 * preview names the count; apply only goes ahead when the request echoes it.
 */
describe("POST /changes/apply — an editor save that empties a half must be confirmed", () => {
  async function previewClear(
    app: ReturnType<typeof buildApp>["app"],
    body: { desiredState: unknown; scope: "guests" | "events" },
  ) {
    const res = await editorPreview(app, body);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      changeId: string;
      clears: { events: number; households: number } | null;
    };
  }

  it("removes every household only with the preview's count echoed back", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const { changeId, clears } = await previewClear(app, {
      desiredState: { events: draftFromDb(db).events, families: [] },
      scope: "guests",
    });
    expect(clears).toEqual({ events: 0, households: 2 });

    const unconfirmed = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { reason: string }).reason).toBe("unconfirmed_clear");
    expect(db.select().from(families).all()).toHaveLength(2);

    // A count that does not match what apply now sees means the preview is out
    // of date — refused as a conflict, not as a malformed request.
    const mismatched = await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId,
      confirmClears: { events: 0, households: 1 },
    });
    expect(mismatched.status).toBe(409);
    expect(db.select().from(families).all()).toHaveLength(2);

    const confirmed = await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId,
      confirmClears: clears,
    });
    expect(confirmed.status).toBe(200);
    expect(db.select().from(families).all()).toHaveLength(0);
  });

  it("removes every event only with the preview's count echoed back", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const { changeId, clears } = await previewClear(app, {
      desiredState: { events: [], families: [] },
      scope: "events",
    });
    expect(clears).toEqual({ events: 2, households: 0 });

    const unconfirmed = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(unconfirmed.status).toBe(400);
    expect(db.select().from(events).all()).toHaveLength(2);

    const confirmed = await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId,
      confirmClears: clears,
    });
    expect(confirmed.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(0);
    // The households were never part of an events save.
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("asks nothing of a save that still leaves households standing", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const draft = draftFromDb(db);
    const { changeId, clears } = await previewClear(app, {
      desiredState: { ...draft, families: draft.families.slice(0, 1) },
      scope: "guests",
    });
    expect(clears).toBeNull();
    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(families).all()).toHaveLength(1);
  });

  it("asks nothing of an empty draft on a wedding with nothing to remove", async () => {
    const { app } = buildApp();
    const { changeId, clears } = await previewClear(app, {
      desiredState: { events: [], families: [] },
      scope: "guests",
    });
    expect(clears).toBeNull();
    expect((await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId })).status).toBe(200);
  });

  it("400s a confirmation that is not two counts", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    for (const confirmClears of [null, { events: "0", households: 2 }]) {
      const { changeId } = await previewClear(app, {
        desiredState: { events: draftFromDb(db).events, families: [] },
        scope: "guests",
      });
      const res = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId, confirmClears });
      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
      expect(db.select().from(families).all()).toHaveLength(2);
    }
  });

  it("does not apply to a spreadsheet upload", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    expect(((await res.json()) as { clears: unknown }).clears).toBeNull();
  });
});

// ── Revert through /changes ─────────────────────────────────────────────────

describe("POST /changes/revert", () => {
  it("reverts an applied change to its before-image", async () => {
    const { app, db } = buildApp();

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const id = ((await preview.json()) as { changeId: string }).changeId;
    await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: id });
    expect(db.select().from(families).all()).toHaveLength(2);

    const revert = await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId: id });
    expect(revert.status).toBe(200);
    // Before-image was the empty pre-import state → revert clears the families.
    expect(db.select().from(families).all()).toHaveLength(0);
  });

  // Only an applied change has anything to undo. A preview has no before-image
  // and would fall back to replaying an older import over everything since; a
  // reverted change would be restored a second time.
  it("409s a change that was only previewed, and changes nothing", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const draft = draftFromDb(db);
    const preview = await editorPreview(app, {
      desiredState: { ...draft, families: draft.families.slice(0, 1) },
      scope: "guests",
    });
    const { changeId } = (await preview.json()) as { changeId: string };
    const head = await headOf(app);

    const res = await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "Change is not applied" });
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(await headOf(app)).toBe(head);
  });

  it("409s a change that is already reverted", async () => {
    const { app, db } = buildApp();
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const id = ((await preview.json()) as { changeId: string }).changeId;
    await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: id });
    expect((await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId: id })).status).toBe(200);

    // Something new lands after the revert; a second revert must not touch it.
    await seedSheets(app);
    const again = await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId: id });
    expect(again.status).toBe(409);
    expect(db.select().from(families).all()).toHaveLength(2);
  });
});

describe("POST /changes/revert — restores only the half the change saved", () => {
  it("reverting an events-editor save leaves a later guests-editor save standing", async () => {
    const { app, db } = buildApp();
    await seedSheets(app);
    const ada = db.select().from(guests).where(eq(guests.firstName, "Ada")).all()[0]!;
    const bo = db.select().from(guests).where(eq(guests.firstName, "Bo")).all()[0]!;

    // The events editor deletes the reception.
    const eventsDraft = draftFromDb(db);
    const eventsSave = await editorPreview(app, {
      desiredState: {
        events: eventsDraft.events.filter((e) => e.name !== "Reception"),
        families: [],
      },
      scope: "events",
    });
    const eventsSaveId = ((await eventsSave.clone().json()) as { changeId: string }).changeId;
    await applyChange(app, eventsSave);

    // Later, the guests editor adds Cy to Ada's household.
    const guestsDraft = draftFromDb(db);
    const testfamily = guestsDraft.families.find((f) => f.familyName === "Testfamily")!;
    const cy = { firstName: "Cy", lastName: "", nickname: null, eventNames: ["Mehndi"] };
    await applyChange(
      app,
      await editorPreview(app, {
        desiredState: {
          ...guestsDraft,
          families: [
            ...guestsDraft.families.filter((f) => f !== testfamily),
            { ...testfamily, guests: [...testfamily.guests, cy] },
          ],
        },
        scope: "guests",
      }),
    );

    const revert = await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId: eventsSaveId });
    expect(revert.status).toBe(200);

    // The reception is back, with the guests who were invited to it…
    const reception = db.select().from(events).where(eq(events.name, "Reception")).all()[0]!;
    const invited = db
      .select({ guestId: guestEvents.guestId })
      .from(guestEvents)
      .where(eq(guestEvents.eventId, reception.id))
      .all()
      .map((l) => l.guestId)
      .toSorted();
    expect(invited).toEqual([ada.id, bo.id].toSorted());
    // …and the later guest edit stands.
    expect(db.select().from(guests).where(eq(guests.firstName, "Cy")).all()).toHaveLength(1);
  });

  describe("who may revert", () => {
    /** An applied two-sheet change, and a check that it is still applied. */
    async function appliedChange(
      app: ReturnType<typeof buildApp>["app"],
      db: ReturnType<typeof buildApp>["db"],
    ) {
      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
        eventsCsv: EVENTS_CSV,
        guestsCsv: GUESTS_CSV,
      });
      const changeId = ((await preview.clone().json()) as { changeId: string }).changeId;
      await applyChange(app, preview);
      const stillApplied = () => {
        const [row] = db
          .select({ status: imports.status })
          .from(imports)
          .where(eq(imports.id, changeId))
          .all();
        expect(row!.status).toBe("applied");
        expect(db.select().from(families).all()).toHaveLength(2);
      };
      return { changeId, stillApplied };
    }

    it("401s a request with no credential", async () => {
      const { app, db } = buildApp();
      const { changeId, stillApplied } = await appliedChange(app, db);
      const res = await appRequest(app, `${CHANGES_BASE}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeId }),
      });
      expect(res.status).toBe(401);
      stillApplied();
    });

    it("401s a cookie that names no session", async () => {
      const { app, db } = buildApp();
      const { changeId, stillApplied } = await appliedChange(app, db);
      await seedOrganiserSession(db, "usr_dev_bootstrap_owner");
      const res = await cookiePost(app, `${CHANGES_BASE}/revert`, "nosuchtoken", { changeId });
      expect(res.status).toBe(401);
      stillApplied();
    });

    it("403s a viewer co-host", async () => {
      const { app, db } = buildApp();
      const { changeId, stillApplied } = await appliedChange(app, db);
      db.insert(weddingHosts)
        .values({
          id: "whost_revert_viewer",
          weddingId: BOOTSTRAP_WEDDING_ID,
          osnProfileId: "usr_revert_viewer",
          addedByOsnProfileId: "usr_dev_bootstrap_owner",
          role: "viewer",
          createdAt: new Date(),
        })
        .run();
      const res = await appRequest(app, `${CHANGES_BASE}/revert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await auth.sign("usr_revert_viewer")}`,
        },
        body: JSON.stringify({ changeId }),
      });
      expect(res.status).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "read_only_role" });
      stillApplied();
    });
  });

  it("answers 402 and changes nothing when a guests revert would pass a cap that shrank since", async () => {
    const { app, db } = buildApp();
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "capacity_500",
        source: "comp",
        grantedBy: "test",
        grantedAt: new Date(),
      })
      .run();
    const guestRows = (n: number) =>
      Array.from({ length: n }, (_, i) => `1,Bigfamily,Guest${i},Bigfamily,no,no`);
    const header = "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception";
    await applyChange(
      app,
      await ownerPost(app, `${CHANGES_BASE}/preview`, {
        eventsCsv: EVENTS_CSV,
        guestsCsv: [header, ...guestRows(101)].join("\n"),
      }),
    );
    // A guests change trims the list to the base cap…
    const trim = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      guestsCsv: [header, ...guestRows(100)].join("\n"),
    });
    const trimId = ((await trim.clone().json()) as { changeId: string }).changeId;
    await applyChange(app, trim);
    // …and then the upgrade goes.
    db.delete(weddingEntitlements)
      .where(eq(weddingEntitlements.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();

    const res = await ownerPost(app, `${CHANGES_BASE}/revert`, { changeId: trimId });
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toMatchObject({ error: "payment_required", limit: 100 });
    expect(db.select().from(guests).all()).toHaveLength(100);
    const [row] = db
      .select({ status: imports.status })
      .from(imports)
      .where(eq(imports.id, trimId))
      .all();
    expect(row!.status).toBe("applied");
  });
});

// ── Provenance default at the route (CSV toggle) ────────────────────────────

describe("POST /changes/preview — provenance default + removeManual toggle", () => {
  async function seedManual(
    app: ReturnType<typeof buildApp>["app"],
    db: ReturnType<typeof buildApp>["db"],
  ) {
    // Import two households, then hand-add a manual one.
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      changeId: ((await preview.json()) as { changeId: string }).changeId,
    });
    const now = new Date();
    db.insert(families)
      .values({
        id: crypto.randomUUID(),
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "MANUAL-ROUTE-0001",
        familyName: "Handadded",
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("default: a CSV re-import leaves the manual household intact", async () => {
    const { app, db } = buildApp();
    await seedManual(app, db);

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const plan = (
      (await preview.json()) as { plan: { familyRemoves: Array<{ familyName: string }> } }
    ).plan;
    expect(plan.familyRemoves.map((f) => f.familyName)).not.toContain("Handadded");
  });

  it("removeManual=true: the CSV re-import removes the manual household", async () => {
    const { app, db } = buildApp();
    await seedManual(app, db);

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
      removeManual: true,
    });
    const plan = (
      (await preview.json()) as { plan: { familyRemoves: Array<{ familyName: string }> } }
    ).plan;
    expect(plan.familyRemoves.map((f) => f.familyName)).toContain("Handadded");
  });

  /**
   * Apply re-reads `removeManual` off the persisted summary, the same way it
   * re-reads `scope` and `matchByName` above. `??` only guards null/undefined,
   * so a stored value that is present but not a real boolean — a truncated
   * write, a hand-edited row — used to sail through unchanged and reach
   * `diffAgainstDb`'s removal loop as a truthy non-boolean, widening the diff
   * exactly as `removeManual: true` would. The decode-and-fall-back-to-false
   * this branch adds only differs from the old `?? false` on this one input,
   * so it needs its own case: neither existing test above writes anything but
   * a real boolean onto the row.
   */
  it("apply treats a corrupt stored removeManual as false, not as truthy", async () => {
    const { app, db } = buildApp();
    await seedManual(app, db);

    // Preview WITHOUT the toggle — same request as the "default" case above,
    // so the plan does not manage the manually-added household.
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await preview.json()) as { changeId: string };

    // Corrupt the stored summary: `removeManual` present, but a string, not a
    // boolean. A naive `stored.removeManual ?? false` would pass "false"
    // through as-is, and a non-empty string is truthy.
    const row = db.select().from(imports).where(eq(imports.id, changeId)).all()[0]!;
    const summary = JSON.parse(row.summary) as Record<string, unknown>;
    summary.removeManual = "false";
    db.update(imports)
      .set({ summary: JSON.stringify(summary) })
      .where(eq(imports.id, changeId))
      .run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
    expect(
      db
        .select()
        .from(families)
        .all()
        .map((f) => f.familyName),
    ).toContain("Handadded");
  });

  it("apply treats a stored removeManual of 1 the same way", async () => {
    const { app, db } = buildApp();
    await seedManual(app, db);

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await preview.json()) as { changeId: string };

    const row = db.select().from(imports).where(eq(imports.id, changeId)).all()[0]!;
    const summary = JSON.parse(row.summary) as Record<string, unknown>;
    summary.removeManual = 1;
    db.update(imports)
      .set({ summary: JSON.stringify(summary) })
      .where(eq(imports.id, changeId))
      .run();

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
    expect(
      db
        .select()
        .from(families)
        .all()
        .map((f) => f.familyName),
    ).toContain("Handadded");
  });
});

// ── Authz + multi-tenant isolation on /changes ──────────────────────────────

describe("authz — /changes gate", () => {
  it("403s a non-member before parsing the body, not 400", async () => {
    const { app } = buildApp();
    // Deliberately malformed body: a 400 here would mean the parse beat the
    // gate, telling a stranger their JSON was fine before refusing them.
    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign("usr_not_a_member")}`,
      },
      body: "{not json",
    });
    expect(res.status).toBe(403);
  });

  it("401 without an OSN JWT", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(401);
  });

  it("403 read_only_role for a viewer co-host", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_changes_viewer",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_changes_viewer",
        addedByOsnProfileId: "usr_dev_bootstrap_owner",
        role: "viewer",
        createdAt: new Date(),
      })
      .run();

    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign("usr_changes_viewer")}`,
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "read_only_role" });
  });

  it("lets an editor co-host preview + apply", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_changes_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_changes_editor",
        addedByOsnProfileId: "usr_dev_bootstrap_owner",
        role: "editor",
        createdAt: new Date(),
      })
      .run();
    const editorBearer = await auth.sign("usr_changes_editor");
    const previewRes = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorBearer}` },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(previewRes.status).toBe(200);
    const id = ((await previewRes.json()) as { changeId: string }).changeId;
    const applyRes = await appRequest(app, `${CHANGES_BASE}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorBearer}` },
      body: JSON.stringify({ changeId: id }),
    });
    expect(applyRes.status).toBe(200);
  });

  it("multi-tenant: a change previewed on one wedding cannot be applied via another", async () => {
    const { app, db } = buildApp();

    // A second wedding owned by the same caller.
    const OTHER = "wed_other_changes";
    const now = new Date();
    db.insert(weddings)
      .values({
        id: OTHER,
        slug: "other-changes",
        displayName: "Other",
        ownerOsnProfileId: "usr_dev_bootstrap_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const id = ((await preview.json()) as { changeId: string }).changeId;

    // Apply the bootstrap-wedding change through the OTHER wedding's path → 404.
    const applyOther = await appRequest(app, `/api/organiser/weddings/${OTHER}/changes/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ changeId: id }),
    });
    expect(applyOther.status).toBe(404);
  });
});

// ── Authn: the organiser session cookie on /changes ─────────────────────────

// Spelled out rather than imported: `lib/cookie.ts` keeps its names private, and
// a test that hard-codes the wire name catches a rename that would sign every
// organiser out.
const ORGANISER_COOKIE_NAME = "cire_org_session";

/**
 * A POST the way a signed-in browser sends it: the session cookie and no
 * `Authorization` header. `appRequest` adds the allowlisted `Origin` unless
 * `origin` replaces it; `bearer` adds a bearer token beside the cookie.
 */
function cookiePost(
  app: ReturnType<typeof buildApp>["app"],
  path: string,
  sessionToken: string,
  body: object,
  extra: { origin?: string; bearer?: string } = {},
) {
  return appRequest(app, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${ORGANISER_COOKIE_NAME}=${sessionToken}`,
      ...(extra.origin ? { Origin: extra.origin } : {}),
      ...(extra.bearer ? { Authorization: `Bearer ${extra.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Every other case in this file signs in with a bearer token. A browser sends
 * the `cire_org_session` cookie instead, and `osnAuth` tries it first. These
 * cases send the cookie with no bearer, so the bearer path cannot answer for
 * them, except the two at the end, which send both to pin the order. Every
 * organiser route shares the one resolver, so one write route shows the cookie
 * reaches it.
 */
describe("authn — the organiser session cookie on /changes", () => {
  const csvBody = { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV };

  it("lets a live session cookie preview and apply, as a bearer does", async () => {
    const { app, db } = buildApp();
    const session = await seedOrganiserSession(db, "usr_dev_bootstrap_owner");

    const previewRes = await cookiePost(app, `${CHANGES_BASE}/preview`, session, csvBody);
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      changeId: string;
      baseRevision: string;
      plan: { familyCreates: unknown[] };
    };
    expect(preview.baseRevision).toBe("genesis");
    expect(preview.plan.familyCreates).toHaveLength(2);

    const applyRes = await cookiePost(app, `${CHANGES_BASE}/apply`, session, {
      changeId: preview.changeId,
    });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
  });

  it("401s a cookie that names no session, with no bearer to fall back on", async () => {
    const { app, db } = buildApp();
    // The owner is signed in elsewhere, so a lookup that ignored the token and
    // took any live row would let this through.
    await seedOrganiserSession(db, "usr_dev_bootstrap_owner");
    const res = await cookiePost(app, `${CHANGES_BASE}/preview`, "nosuchtoken", csvBody);
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("401s the same cookie once its session has expired", async () => {
    const { app, db } = buildApp();
    const session = await seedOrganiserSession(db, "usr_dev_bootstrap_owner");
    expect((await cookiePost(app, `${CHANGES_BASE}/preview`, session, csvBody)).status).toBe(200);
    expect(db.select().from(imports).all()).toHaveLength(1);

    // Only the row's expiry moves; the browser still holds the same token.
    db.update(organiserSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(organiserSessions.osnProfileId, "usr_dev_bootstrap_owner"))
      .run();

    const res = await cookiePost(app, `${CHANGES_BASE}/preview`, session, csvBody);
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
    expect(db.select().from(imports).all()).toHaveLength(1);
  });

  it("403s a live cookie whose profile is not on the wedding", async () => {
    const { app, db } = buildApp();
    const session = await seedOrganiserSession(db, "usr_not_a_member");
    const res = await cookiePost(app, `${CHANGES_BASE}/preview`, session, csvBody);
    expect(res.status).toBe(403);
    // No `message` key: the wedding gate refused, not the origin guard.
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  // The origin guard reads `Origin`, not the credential. What this pins is that
  // the route is mounted behind the guard, which is what stops a cross-site form
  // from riding the owner's cookie.
  it("403s a live cookie sent from a foreign origin — the route sits behind the origin guard", async () => {
    const { app, db } = buildApp();
    const session = await seedOrganiserSession(db, "usr_dev_bootstrap_owner");
    const res = await cookiePost(app, `${CHANGES_BASE}/preview`, session, csvBody, {
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden", message: "Origin not allowed" });
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("reads a live cookie before a bearer — the cookie's profile is the caller", async () => {
    const { app, db } = buildApp();
    const session = await seedOrganiserSession(db, "usr_not_a_member");
    const res = await cookiePost(app, `${CHANGES_BASE}/preview`, session, csvBody, { bearer });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
  });

  it("falls through to the bearer when the cookie names no session", async () => {
    const { app } = buildApp();
    const res = await cookiePost(app, `${CHANGES_BASE}/preview`, "nosuchtoken", csvBody, {
      bearer,
    });
    expect(res.status).toBe(200);
  });
});

// ── Capacity enforcement: 402 on breach ─────────────────────────────────────

describe("POST /changes/apply — 402 on capacity breach", () => {
  /**
   * Build a CSV with N guests in a single family, using EVENTS_CSV events.
   * Each guest is invited to no events (all 'no') to keep the CSV simple.
   */
  function buildLargeGuestsCsv(n: number): string {
    const header = "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception";
    const rows = Array.from({ length: n }, (_, i) => `1,Bigfamily,Guest${i},Bigfamily,no,no`);
    return [header, ...rows].join("\n");
  }

  it("applying a change that would exceed the cap returns 402 with payment_required body and persists no guests", async () => {
    const { app, db } = buildApp();

    // Preview + apply 101 guests (cap is 100, no capacity entitlement).
    const guestsCsv = buildLargeGuestsCsv(101);

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv,
    });
    expect(previewRes.status).toBe(200);
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(402);
    const body = (await applyRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.entitlement).toBe("capacity");
    expect(body.limit).toBe(100);
    expect(typeof body.current).toBe("number");

    // Atomic: no guests were persisted.
    expect(db.select().from(guests).all()).toHaveLength(0);
    expect(db.select().from(families).all()).toHaveLength(0);
    // And the change row still reads `preview` — the status flip rides in the
    // write set's final batch (applyImport `finalize`), so a failed apply must
    // never strand the row as `applied` (that re-opens the double-apply /
    // before-image-destruction window).
    const [row] = db
      .select({ status: imports.status })
      .from(imports)
      .where(eq(imports.id, changeId))
      .all();
    expect(row!.status).toBe("preview");
  });

  it("applying a change within cap succeeds; upgraded wedding (capacity_500) admits up to 500", async () => {
    const { app, db } = buildApp();

    // Grant capacity_500 to the bootstrap wedding.
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "capacity_500",
        source: "comp",
        grantedAt: new Date(),
        grantedBy: "usr_admin",
      })
      .run();

    // 101 guests < 500 → should succeed.
    const guestsCsv = buildLargeGuestsCsv(101);
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(guests).all()).toHaveLength(101);
  });
});

// ── Apply guards, payload cap, history paging ───────────────────────────────
//
// These moved here from the deleted `/import` alias test file. Nothing in them
// was alias-specific — the alias just happened to be the mount they were
// written against.

describe("POST /changes/apply — change-row guards", () => {
  it("404s an unknown changeId", async () => {
    const { app } = buildApp();
    const res = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId: "nonexistent" });
    expect(res.status).toBe(404);
  });

  it("409s a change that has left preview status (TOCTOU defence)", async () => {
    const { app, db } = buildApp();
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };
    // Stand in for a concurrent apply landing first.
    db.update(imports).set({ status: "applied" }).where(eq(imports.id, changeId)).run();

    const res = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(res.status).toBe(409);
  });

  it("400s the alias-era `importId` body", async () => {
    const { app } = buildApp();
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const res = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: changeId });
    expect(res.status).toBe(400);
  });
});

describe("the /import alias is gone", () => {
  it("404s the old preview path", async () => {
    const { app } = buildApp();
    const res = await ownerPost(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/import/preview`,
      { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /changes/preview — 1MB payload cap", () => {
  it("413s a body that declares more than 1MB", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        // Lying header — the pre-check must refuse before any parse happens.
        "Content-Length": String(2 * 1024 * 1024),
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(413);
  });

  it("413s a body that really is over 1MB when the header is absent", async () => {
    const { app } = buildApp();
    // A CSV whose real bytes clear the cap, for the post-parse backup arm that
    // covers CDNs stripping or faking Content-Length.
    // Under the parser's 5000-row and 10k-cell caps, over the 1MB byte cap.
    const pad = "x".repeat(100);
    const fat = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
      ...Array.from(
        { length: 4_900 },
        (_, i) => `${i},Testfamily${pad}${i},Ada${pad}${i},Testfamily${i},yes,yes`,
      ),
    ].join("\n");
    expect(new TextEncoder().encode(fat).length).toBeGreaterThan(1024 * 1024);

    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: fat }),
    });
    expect(res.status).toBe(413);
  });
});

describe("GET /changes/list — history paging", () => {
  async function seedChange(app: ReturnType<typeof buildApp>["app"]) {
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    return ((await res.json()) as { changeId: string }).changeId;
  }

  it("returns the wedding's changes newest-first", async () => {
    const { app } = buildApp();
    const id = await seedChange(app);

    const res = await ownerGet(app, `${CHANGES_BASE}/list`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imports: { id: string }[]; nextCursor: number | null };
    expect(body.imports.find((i) => i.id === id)).toBeDefined();
    expect(body.nextCursor).toBeNull();
  });

  it("names the halves a revert of each change restores", async () => {
    const { app, db } = buildApp();
    const both = await seedChange(app);
    const eventsOnly = (
      (await (
        await ownerPost(app, `${CHANGES_BASE}/preview`, { eventsCsv: EVENTS_CSV })
      ).json()) as { changeId: string }
    ).changeId;
    const guestsOnly = (
      (await (
        await ownerPost(app, `${CHANGES_BASE}/preview`, {
          guestsCsv: "Family ID,Family Name,Guest First Name,Guest Last Name\n1,Testfamily,Ada,T",
        })
      ).json()) as { changeId: string }
    ).changeId;
    // A row whose summary lost its scope restores both halves.
    db.update(imports).set({ summary: "{}" }).where(eq(imports.id, both)).run();

    const res = await ownerGet(app, `${CHANGES_BASE}/list`);
    const body = (await res.json()) as { imports: { id: string; scope: string }[] };
    const scopeOf = new Map(body.imports.map((i) => [i.id, i.scope]));
    expect(scopeOf.get(both)).toBe("both");
    expect(scopeOf.get(eventsOnly)).toBe("events");
    expect(scopeOf.get(guestsOnly)).toBe("guests");
  });

  it("pages on `?limit` and `?cursor`", async () => {
    const { app, db } = buildApp();
    const id1 = await seedChange(app);
    db.update(imports).set({ uploadedAt: 1_000 }).where(eq(imports.id, id1)).run();
    const id2 = await seedChange(app);
    db.update(imports).set({ uploadedAt: 2_000 }).where(eq(imports.id, id2)).run();
    const id3 = await seedChange(app);
    db.update(imports).set({ uploadedAt: 3_000 }).where(eq(imports.id, id3)).run();

    const page1Res = await ownerGet(app, `${CHANGES_BASE}/list?limit=2`);
    const page1 = (await page1Res.json()) as {
      imports: { id: string }[];
      nextCursor: number | null;
    };
    expect(page1.imports.map((i) => i.id)).toEqual([id3, id2]);
    expect(page1.nextCursor).toBe(2_000);

    const page2Res = await ownerGet(app, `${CHANGES_BASE}/list?limit=2&cursor=2000`);
    const page2 = (await page2Res.json()) as {
      imports: { id: string }[];
      nextCursor: number | null;
    };
    expect(page2.imports.map((i) => i.id)).toEqual([id1]);
    expect(page2.nextCursor).toBeNull();
  });

  it("403s a viewer co-host — the list sits behind the editor gate", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_list_viewer",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_list_viewer",
        addedByOsnProfileId: "usr_dev_bootstrap_owner",
        role: "viewer",
        createdAt: new Date(),
      })
      .run();

    const res = await appRequest(app, `${CHANGES_BASE}/list`, {
      method: "GET",
      headers: { Authorization: `Bearer ${await auth.sign("usr_list_viewer")}` },
    });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "read_only_role" });
  });

  it("clamps `?limit` to 1..100", async () => {
    const { app } = buildApp();
    await seedChange(app);

    const tiny = await ownerGet(app, `${CHANGES_BASE}/list?limit=0`);
    expect(((await tiny.json()) as { imports: unknown[] }).imports).toHaveLength(1);

    const huge = await ownerGet(app, `${CHANGES_BASE}/list?limit=999`);
    expect(huge.status).toBe(200);
  });
});

// ── Tenant isolation: a second wedding is invisible to the diff ─────────────

describe("wedding scoping: a change is tenant-isolated", () => {
  // A SECOND wedding owned by someone else, pre-populated with its own event,
  // family and guest. Every call here targets the bootstrap wedding's path,
  // so the second tenant's rows must be invisible to the diff and untouched
  // by apply.
  const OTHER_EVENT = "evt_second_party";
  const OTHER_FAMILY = "fam_second";
  const OTHER_GUEST = "gst_second";

  function addSecondWedding(db: ReturnType<typeof buildApp>["db"]) {
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_second",
        slug: "second-wedding",
        displayName: "Second Wedding",
        ownerOsnProfileId: "usr_someone_else",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(events)
      .values({
        id: OTHER_EVENT,
        weddingId: "wed_second",
        slug: "second-party",
        name: "Second Party",
        description: "",
        startAt: "2027-02-02T10:00:00+11:00",
        endAt: "2027-02-02T12:00:00+11:00",
        timezone: "Australia/Sydney",
        address: null,
        dressCodeDescription: null,
        dressCodePalette: null,
        pinterestUrl: null,
        mapsUrl: null,
        sortOrder: 0,
      })
      .run();
    db.insert(families)
      .values({
        id: OTHER_FAMILY,
        weddingId: "wed_second",
        publicId: "SECOND-FAM",
        familyName: "Secondfamily",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(guests)
      .values({
        id: OTHER_GUEST,
        familyId: OTHER_FAMILY,
        firstName: "Zoe",
        lastName: "Secondfamily",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("previews scoped to the caller's wedding when a second wedding exists", async () => {
    const { app, db } = buildApp();
    addSecondWedding(db);

    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { eventRemoves: unknown[]; familyRemoves: unknown[]; guestRemoves: unknown[] };
    };
    // The other tenant's rows are out of scope, so nothing is flagged for removal.
    expect(body.plan.eventRemoves).toHaveLength(0);
    expect(body.plan.familyRemoves).toHaveLength(0);
    expect(body.plan.guestRemoves).toHaveLength(0);
  });

  it("apply only touches the caller's wedding, leaving the other tenant intact", async () => {
    const { app, db } = buildApp();
    addSecondWedding(db);

    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const { changeId } = (await res.json()) as { changeId: string };

    const apply = await ownerPost(app, `${CHANGES_BASE}/apply`, { changeId });
    expect(apply.status).toBe(200);

    // Bootstrap wedding got its change; the second tenant's rows survived.
    expect(
      db.select().from(events).where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID)).all(),
    ).toHaveLength(2);
    expect(db.select().from(events).where(eq(events.id, OTHER_EVENT)).all()).toHaveLength(1);
    expect(db.select().from(families).where(eq(families.id, OTHER_FAMILY)).all()).toHaveLength(1);
    expect(db.select().from(guests).where(eq(guests.id, OTHER_GUEST)).all()).toHaveLength(1);
  });
});
