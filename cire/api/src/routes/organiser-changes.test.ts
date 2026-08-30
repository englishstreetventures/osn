import { describe, it, expect, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guests,
  guestEvents,
  imports,
  weddingEntitlements,
  weddingHosts,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { createR2Stub } from "../services/r2-imports";
import { appRequest, jsonBody } from "../test-helpers";
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

    // Drop an event between preview and apply. Direct event routes don't advance
    // headRevision, so the 409 concurrency guard doesn't fire — the apply-time
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

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState });
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
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState });
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
    const res = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState: blankName });
    expect(res.status).toBe(400);
  });

  it("saves a HOUSEHOLD NAME edit — id-matched rename writes through, code + guests survive", async () => {
    const { app, db } = buildApp();

    // Seed through the editor front door, then read back what a draft loads.
    const seed = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState });
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
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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
      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState: seedState });
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

      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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

      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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
      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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

      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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
      const res = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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
      const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
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
    const body = (await applyA.json()) as { error: string; currentRevision: string };
    expect(body.error).toBe("State changed — re-preview");
    expect(body.currentRevision).toBe(idB);
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
