import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  directoryVendorCategories,
  directoryVendors,
  events,
  families,
  guestEvents,
  guests,
  registryClaims,
  registryContributions,
  registryItems,
  registrySettings,
  rsvps,
  tasks,
  weddingFaqs,
  weddingInviteCustomisations,
  weddings,
  BOOTSTRAP_WEDDING_ID,
} from "@cire/db";
import { asc, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";
import { Miniflare } from "miniflare";

import { createSessionRoutedClient, runInD1Session } from "../../src/db/d1-session";
import { createD1Db, DbService } from "../../src/db/index";
import type { Db } from "../../src/db/index";
import { DDL } from "../../src/db/setup";
import type { ImportPlan } from "../../src/schemas/import";
import { FAQ_LIMITS } from "../../src/schemas/invite-faq";
import { claimService } from "../../src/services/claim";
import { createDirectoryService } from "../../src/services/directory";
import { giftExportService } from "../../src/services/gift-export";
import { applyImport } from "../../src/services/import";
import { inviteService } from "../../src/services/invite";
import { FaqLimitReached, inviteFaqService } from "../../src/services/invite-faq";
import { registryService, SettingsChanged } from "../../src/services/registry";
import { type GiftSummaryNotice, retentionService } from "../../src/services/retention";
import { rsvpService } from "../../src/services/rsvp";
import { tasksService } from "../../src/services/tasks";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// The rest of the suite runs on synchronous bun:sqlite; these exercise the
// ASYNCHRONOUS D1 driver path that production actually uses — the `dbQuery`
// bridge, awaited writes, and the `db.batch([...])` branch of `applyImport`
// (which bun:sqlite cannot reach). This is the only coverage of that path.

// Schema setup and FK-ordered truncation are inherently sequential here.
/* eslint-disable no-await-in-loop */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIGRATION_0063 = "0063_invite_section_visibility.sql";

/**
 * A migration file as the statements wrangler would send: split on drizzle's
 * breakpoint marker, comment lines dropped. Every chunk in the chain holds one
 * statement, and D1's `prepare` takes exactly one.
 */
function migrationStatements(file: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

const PUBLIC_ID = "TESTFAM-AA01";
const FAMILY_ID = "fam1";
const EVENT_A = "evt_a";
const EVENT_B = "evt_b";
const GUEST_1 = "g1";
const GUEST_2 = "g2";

let mf: Miniflare;
let d1: D1Database;
let db: Db;

// Booting workerd (which backs Miniflare's D1) is a cold-start the first time a
// CI runner touches it: spawning the runtime + opening the loopback socket can
// take several seconds on a fresh, network-constrained GitHub Actions box. bun's
// DEFAULT per-hook timeout is 5_000ms, so a slow boot makes the `beforeAll`
// (or a `beforeEach` issuing the first real D1 round-trip) blow past it — bun
// then fails the hook AND tears the suite down, at which point the still-pending
// workerd D1 call lands on a now-disposed ("poisoned") stub and surfaces as
// "Unhandled error between tests", failing the whole `bun test` run. Locally the
// runtime is warm so the hooks finish in ~400ms and never trip the limit; this
// is the CI-only flake.
//
// The same 5_000ms default applies per TEST, and the bodies here are not cheap:
// every statement is a real round-trip over workerd's loopback socket, so a test
// that seeds 51 events one at a time takes ~6-9s on a CI box against ~0.4s
// locally. That is the same flake wearing a different hat, and it tears the
// suite down the same way — the run that prompted this saw the 51-pair test time
// out at 5_000ms and the next test fail 16ms later on the poisoned stub. So the
// budget covers hooks and tests alike: nothing Miniflare-backed races the
// default.
const MF_TIMEOUT_MS = 30_000;

const run = <A, E>(eff: Effect.Effect<A, E, DbService>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

async function seed(): Promise<void> {
  const now = new Date();
  await db.insert(weddings).values({
    id: BOOTSTRAP_WEDDING_ID,
    slug: "w",
    displayName: "W",
    ownerOsnProfileId: "usr_test",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(events).values([
    {
      id: EVENT_A,
      weddingId: BOOTSTRAP_WEDDING_ID,
      slug: "ceremony",
      name: "Ceremony",
      description: "",
      startAt: "",
      endAt: "",
      timezone: "",
      sortOrder: 0,
    },
    {
      id: EVENT_B,
      weddingId: BOOTSTRAP_WEDDING_ID,
      slug: "reception",
      name: "Reception",
      description: "",
      startAt: "",
      endAt: "",
      timezone: "",
      sortOrder: 1,
    },
  ]);
  await db.insert(families).values({
    id: FAMILY_ID,
    weddingId: BOOTSTRAP_WEDDING_ID,
    publicId: PUBLIC_ID,
    familyName: "Test",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(guests).values([
    {
      id: GUEST_1,
      familyId: FAMILY_ID,
      firstName: "Alice",
      lastName: "Test",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: GUEST_2,
      familyId: FAMILY_ID,
      firstName: "Bob",
      lastName: "Test",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(guestEvents).values([
    { guestId: GUEST_1, eventId: EVENT_A },
    { guestId: GUEST_1, eventId: EVENT_B },
    { guestId: GUEST_2, eventId: EVENT_A },
  ]);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  // Apply the schema statement-by-statement — D1's `exec` splits on newlines,
  // which breaks multi-line CREATE TABLEs, so prepare/run each full statement.
  for (const stmt of DDL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await d1.prepare(stmt).run();
  }
  // Over the session-routing shim, exactly as `index.ts` builds it, so every
  // service test in this file exercises the production client path rather than
  // a raw binding the deployed Worker never uses. With no session in scope the
  // shim delegates straight to `d1`, which is the point: the shim has to be
  // transparent to all of this.
  db = createD1Db(createSessionRoutedClient(d1, "fetch"));
}, MF_TIMEOUT_MS);

afterAll(async () => {
  // `dispose()` poisons every D1 stub this instance handed out — only call it
  // once the suite is fully done so no in-flight query can resolve against a
  // dead stub. (All hooks/tests above `await` their D1 ops, so nothing is
  // pending here; this stays defensive in case that ever changes.)
  await mf?.dispose();
}, MF_TIMEOUT_MS);

beforeEach(async () => {
  // FK-safe truncate, then reseed — keeps each test isolated on the shared D1.
  for (const table of [
    directoryVendorCategories,
    directoryVendors,
    rsvps,
    guestEvents,
    guests,
    families,
    events,
    tasks,
    registrySettings,
    weddingFaqs,
    weddings,
  ]) {
    await db.delete(table);
  }
  await seed();
}, MF_TIMEOUT_MS);

describe("cire/api over real D1 (Miniflare)", () => {
  it(
    "claim.lookup resolves a seeded family across async D1 reads",
    async () => {
      const res = await run(claimService.lookup(PUBLIC_ID));
      expect(res.familyId).toBe(FAMILY_ID);
      expect(res.publicId).toBe(PUBLIC_ID);
      expect(res.members).toHaveLength(2);
      expect(res.events.map((e) => e.name).toSorted()).toEqual(["Ceremony", "Reception"]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "claim.lookup gives the same answer inside a D1 session",
    async () => {
      // The deployed shape: the whole dispatch runs inside one session, so a
      // multi-read service call has its reads routed to the session rather than
      // the binding. Nothing about the result may change.
      const res = await runInD1Session(d1, () => run(claimService.lookup(PUBLIC_ID)));
      expect(res.familyId).toBe(FAMILY_ID);
      expect(res.members).toHaveLength(2);
      expect(res.events.map((e) => e.name).toSorted()).toEqual(["Ceremony", "Reception"]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "claim.lookup fails for an unknown code",
    async () => {
      await expect(run(claimService.lookup("NOPE-0000"))).rejects.toThrow();
    },
    MF_TIMEOUT_MS,
  );

  it(
    "submitRsvp upserts over async D1 (insert then in-place update)",
    async () => {
      await run(
        rsvpService.submitRsvp({
          guestId: GUEST_1,
          eventId: EVENT_A,
          status: "attending",
          dietary: "none",
          dietaryPresets: [],
          dietaryConsent: false,
        }),
      );
      let rows = await run(rsvpService.getRsvpsForFamily(FAMILY_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ guestId: GUEST_1, eventId: EVENT_A, status: "attending" });

      // Same (guest, event) conflict target → updates the row in place, no dup.
      await run(
        rsvpService.submitRsvp({
          guestId: GUEST_1,
          eventId: EVENT_A,
          status: "declined",
          dietary: "veg",
          dietaryPresets: [],
          dietaryConsent: false,
        }),
      );
      rows = await run(rsvpService.getRsvpsForFamily(FAMILY_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "declined", dietary: "veg" });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "applyImport commits a write set via the D1 batch path",
    async () => {
      const newEventId = "evt_new";
      const newFamilyId = "fam_new";
      const newGuestId = "g_new";
      const plan: ImportPlan = {
        eventCreates: [
          {
            id: newEventId,
            event: {
              name: "Mehndi",
              startAt: "2026-11-22T10:00",
              endAt: "2026-11-22T14:00",
              timezone: "Australia/Sydney",
              location: "Hall",
              address: null,
              dressCodeDescription: null,
              dressCodePalette: [],
              pinterestUrl: null,
              mapsUrl: null,
              sortOrder: 2,
            },
          },
        ],
        eventUpdates: [],
        eventRemoves: [],
        familyCreates: [{ id: newFamilyId, publicId: "NEWFAM-BB02", familyName: "New" }],
        familyUpdates: [],
        familyRemoves: [],
        guestCreates: [
          {
            id: newGuestId,
            familyId: newFamilyId,
            firstName: "Carol",
            lastName: "New",
            nickname: null,
            sortOrder: 0,
          },
        ],
        guestUpdates: [],
        guestRemoves: [],
        eventLinkCreates: [{ guestId: newGuestId, eventId: newEventId }],
        eventLinkRemoves: [],
        warnings: [],
      };

      const summary = await run(applyImport("imp_test", plan, BOOTSTRAP_WEDDING_ID));
      expect(summary).toMatchObject({ eventsCreated: 1, familiesCreated: 1, guestsCreated: 1 });

      expect(await db.select().from(events).where(eq(events.id, newEventId))).toHaveLength(1);
      expect(await db.select().from(families).where(eq(families.id, newFamilyId))).toHaveLength(1);
      expect(
        await db.select().from(guestEvents).where(eq(guestEvents.guestId, newGuestId)),
      ).toHaveLength(1);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "applyImport batch is atomic — a mid-batch constraint violation persists nothing",
    async () => {
      // Two family creates share a publicId; the second trips the UNIQUE index.
      // On D1 the whole batch is one transaction, so NEITHER row may survive.
      const plan: ImportPlan = {
        eventCreates: [],
        eventUpdates: [],
        eventRemoves: [],
        familyCreates: [
          { id: "fam_x", publicId: "DUP-CODE", familyName: "X" },
          { id: "fam_y", publicId: "DUP-CODE", familyName: "Y" },
        ],
        familyUpdates: [],
        familyRemoves: [],
        guestCreates: [],
        guestUpdates: [],
        guestRemoves: [],
        eventLinkCreates: [],
        eventLinkRemoves: [],
        warnings: [],
      };

      await expect(run(applyImport("imp_dup", plan, BOOTSTRAP_WEDDING_ID))).rejects.toThrow();
      expect(await db.select().from(families).where(eq(families.id, "fam_x"))).toHaveLength(0);
      expect(await db.select().from(families).where(eq(families.id, "fam_y"))).toHaveLength(0);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "submitRsvps commits a 51-pair batch over D1's per-batch ceiling (P-W2)",
    async () => {
      // MAX_STATEMENTS_PER_BATCH is 50; a 51-statement submit must be chunked by
      // commitGroupedBatches rather than sent as one over-ceiling db.batch() call
      // (which D1 rejects outright). bun:sqlite cannot exercise this: commitBatch
      // feature-detects `.batch()` and falls back to a sequential loop there, so
      // only the real (Miniflare-backed) D1 driver proves the fix.
      const eventIds = Array.from({ length: 51 }, (_, i) => `evt_bulk_${i}`);
      // One insert per event, not a single 51-row bulk insert — the bulk form
      // trips D1's own bound-parameter ceiling on a single statement, a
      // different limit than the per-batch statement ceiling this test targets.
      for (const [i, id] of eventIds.entries()) {
        await db.insert(events).values({
          id,
          weddingId: BOOTSTRAP_WEDDING_ID,
          slug: `bulk-${i}`,
          name: `Bulk ${i}`,
          description: "",
          startAt: "",
          endAt: "",
          timezone: "",
          sortOrder: 10 + i,
        });
      }

      const inputs = eventIds.map((eventId) => ({
        guestId: GUEST_1,
        eventId,
        status: "attending" as const,
        dietary: "",
        dietaryPresets: [],
        dietaryConsent: false,
      }));

      await run(rsvpService.submitRsvps(inputs));

      const rows = await db.select().from(rsvps).where(eq(rsvps.guestId, GUEST_1));
      expect(rows).toHaveLength(51);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "submitRsvpsAndList folds the read-back into the write batch over D1 (P-W1)",
    async () => {
      // Real db.batch() is the only environment that can fail the way the fix
      // targets — bun:sqlite's fallback just awaits each statement in order and
      // would pass even if the tail read the wrong rows or ran before the writes.
      const rows = await run(
        rsvpService.submitRsvpsAndList(
          [
            {
              guestId: GUEST_1,
              eventId: EVENT_A,
              status: "attending",
              dietary: "",
              dietaryPresets: [],
              dietaryConsent: false,
            },
            {
              guestId: GUEST_2,
              eventId: EVENT_A,
              status: "declined",
              dietary: "",
              dietaryPresets: [],
              dietaryConsent: false,
            },
          ],
          FAMILY_ID,
        ),
      );

      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.guestId === GUEST_1)).toMatchObject({
        guestId: GUEST_1,
        eventId: EVENT_A,
        status: "attending",
      });
      expect(rows.find((r) => r.guestId === GUEST_2)).toMatchObject({
        guestId: GUEST_2,
        eventId: EVENT_A,
        status: "declined",
      });

      // Persisted, not just echoed back.
      const persisted = await db.select().from(rsvps).where(eq(rsvps.guestId, GUEST_1));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ status: "attending" });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "submitRsvpsAndList sends the tail as its own trailing batch at the chunk ceiling",
    async () => {
      // MAX_STATEMENTS_PER_BATCH is 50. 50 upsert statements exactly fill the
      // first chunk, so commitGroupedBatchesReturning must flush it and send the
      // tail read as its own trailing batch rather than folding it in — proving
      // the ceiling path (not just the common under-ceiling path above) still
      // returns the full row set.
      const eventIds = Array.from({ length: 50 }, (_, i) => `evt_ceiling_${i}`);
      for (const [i, id] of eventIds.entries()) {
        await db.insert(events).values({
          id,
          weddingId: BOOTSTRAP_WEDDING_ID,
          slug: `ceiling-${i}`,
          name: `Ceiling ${i}`,
          description: "",
          startAt: "",
          endAt: "",
          timezone: "",
          sortOrder: 20 + i,
        });
      }

      const inputs = eventIds.map((eventId) => ({
        guestId: GUEST_1,
        eventId,
        status: "attending" as const,
        dietary: "",
        dietaryPresets: [],
        dietaryConsent: false,
      }));

      const rows = await run(rsvpService.submitRsvpsAndList(inputs, FAMILY_ID));

      expect(rows).toHaveLength(50);
      expect(new Set(rows.map((r) => r.eventId))).toEqual(new Set(eventIds));

      const persisted = await db.select().from(rsvps).where(eq(rsvps.guestId, GUEST_1));
      expect(persisted).toHaveLength(50);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "tasks.reorder commits its per-row updates over the D1 batch path",
    async () => {
      // Regression guard: reorder used to run through db.transaction(), which the
      // D1 driver implements as literal BEGIN/COMMIT (rejected by D1) with
      // fire-and-forget .run() calls that the async driver never awaited. It now
      // goes through commitBatch — this is the only D1 coverage of a reorder.
      const created: string[] = [];
      for (const title of ["first", "second", "third"]) {
        const dto = await run(
          tasksService.create({
            weddingId: BOOTSTRAP_WEDDING_ID,
            title,
            timeframeBucket: "12m",
            notes: null,
            dueAt: null,
          }),
        );
        created.push(dto.id);
      }

      const reversed = created.toReversed();
      await run(tasksService.reorder(BOOTSTRAP_WEDDING_ID, "12m", reversed));

      const rows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.weddingId, BOOTSTRAP_WEDDING_ID))
        .orderBy(asc(tasks.sortOrder));
      expect(rows.map((r) => r.id)).toEqual(reversed);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "gift export reads both tables in one union and prints every cell in place",
    async () => {
      // The D1 driver maps a union's rows by POSITION, using the first
      // branch's fields, so a column out of step shows up here as a value in
      // the wrong cell. The truncation above clears these rows through the
      // foreign keys: items cascade from the wedding, claims and cash gifts
      // from the family.
      const at = (minutes: number) => new Date(Date.UTC(2026, 7, 20, 10, minutes, 0));
      await db.insert(registryItems).values({
        id: "ritem_d1",
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Copper Pan",
        createdAt: at(0),
        updatedAt: at(0),
      });
      await db.insert(registryClaims).values({
        id: "rclaim_d1",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "ritem_d1",
        familyId: FAMILY_ID,
        quantity: 2,
        status: "purchased",
        note: "Bought the pair",
        displayName: "Auntie Ros",
        thankedAt: at(5),
        createdAt: at(1),
        updatedAt: at(5),
      });
      await db.insert(registryContributions).values({
        id: "rcon_d1",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "ritem_d1",
        familyId: FAMILY_ID,
        status: "succeeded",
        displayName: "Uncle Jo",
        message: "Towards the pan",
        amountMinor: 20_000,
        currency: "JPY",
        primaryAmountMinor: 20_400,
        primaryCurrency: "AUD",
        fxRate: "0.0102",
        thankedAt: at(6),
        createdAt: at(2),
        updatedAt: at(6),
      });

      const csv = await run(giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID));
      expect(csv.split("\r\n").slice(1)).toEqual([
        "Cash gift,Copper Pan,Test,Uncle Jo,,succeeded,Towards the pan,20000,JPY,204.00,AUD,0.0102,2026-08-20T10:06:00.000Z,2026-08-20T10:02:00.000Z",
        "Gift list,Copper Pan,Test,Auntie Ros,2,purchased,Bought the pair,,,,,,2026-08-20T10:05:00.000Z,2026-08-20T10:01:00.000Z",
      ]);

      // A host hides both notes. `UPDATE … RETURNING` and the extra column in
      // each union branch both run on the D1 driver here, not only on bun:sqlite.
      for (const [kind, giftId] of [
        ["claim", "rclaim_d1"],
        ["contribution", "rcon_d1"],
      ] as const) {
        expect(
          await run(
            registryService.setNoteHidden({
              weddingId: BOOTSTRAP_WEDDING_ID,
              kind,
              giftId,
              hidden: true,
              actorOsnProfileId: "usr_editor",
            }),
          ),
        ).toEqual({ note: null, noteHidden: true });
      }
      const hiddenCsv = await run(giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID));
      expect(hiddenCsv.split("\r\n").slice(1)).toEqual([
        "Cash gift,Copper Pan,Test,Uncle Jo,,succeeded,Note hidden,20000,JPY,204.00,AUD,0.0102,2026-08-20T10:06:00.000Z,2026-08-20T10:02:00.000Z",
        "Gift list,Copper Pan,Test,Auntie Ros,2,purchased,Note hidden,,,,,,2026-08-20T10:05:00.000Z,2026-08-20T10:01:00.000Z",
      ]);
      const { entries } = await run(registryService.giftLog(BOOTSTRAP_WEDDING_ID));
      expect(entries.map((e) => [e.note, e.noteHidden])).toEqual([
        [null, true],
        [null, true],
      ]);

      expect(
        await run(
          registryService.setNoteHidden({
            weddingId: BOOTSTRAP_WEDDING_ID,
            kind: "contribution",
            giftId: "rcon_d1",
            hidden: false,
            actorOsnProfileId: "usr_editor",
          }),
        ),
      ).toEqual({ note: "Towards the pan", noteHidden: false });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "registry settings: a stale expected value is refused on D1 and changes nothing",
    async () => {
      // The refusal rests on the upsert's `DO UPDATE ... WHERE` returning no row
      // when the WHERE fails — a property of the engine, so it is pinned on D1
      // as well as on bun:sqlite.
      await run(
        registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
          published: true,
          shippingAddress: "1 Example St",
        }),
      );
      await run(registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { shippingAddress: null }));

      const exit = await Effect.runPromiseExit(
        registryService
          .updateSettings(BOOTSTRAP_WEDDING_ID, {
            shippingAddress: "2 Example St",
            expected: { shippingAddress: "1 Example St" },
          })
          .pipe(Effect.provideService(DbService, db)),
      );
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error).toBeInstanceOf(SettingsChanged);

      const [row] = await db
        .select({ shippingAddress: registrySettings.shippingAddress })
        .from(registrySettings)
        .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID));
      expect(row?.shippingAddress).toBeNull();

      // A matching expectation writes.
      const saved = await run(
        registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
          shippingAddress: "2 Example St",
          expected: { shippingAddress: null },
        }),
      );
      expect(saved.shippingAddress).toBe("2 Example St");
    },
    MF_TIMEOUT_MS,
  );
  it(
    "getLiveListingById maps the listing and its categories from one joined read",
    async () => {
      const now = new Date();
      const listing = {
        ownerOrgId: null,
        description: null,
        email: "hello@example.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(directoryVendors).values([
        { ...listing, id: "dv_two", name: "Two Categories", listed: "live" },
        { ...listing, id: "dv_none", name: "No Categories", listed: "live" },
        { ...listing, id: "dv_draft", name: "Draft", listed: "draft" },
      ]);
      await db.insert(directoryVendorCategories).values([
        { directoryVendorId: "dv_two", category: "venue" },
        { directoryVendorId: "dv_two", category: "catering" },
        { directoryVendorId: "dv_draft", category: "venue" },
      ]);
      const directory = createDirectoryService();

      const two = await run(directory.getLiveListingById("dv_two"));
      expect(two?.name).toBe("Two Categories");
      expect(two?.createdAt).toBe(Math.floor(now.getTime() / 1000) * 1000);
      expect(two?.categories.toSorted()).toEqual(["catering", "venue"]);

      const none = await run(directory.getLiveListingById("dv_none"));
      expect(none?.categories).toEqual([]);

      expect(await run(directory.getLiveListingById("dv_draft"))).toBeNull();
      expect(await run(directory.getLiveListingById("dv_missing"))).toBeNull();
    },
    MF_TIMEOUT_MS,
  );

  it(
    "the retention sweep dates each gift summary notice from its cohort read",
    async () => {
      // Give the seeded wedding real dates: the final event is open-ended, so
      // its start is its effective end.
      await db
        .update(events)
        .set({ startAt: "2025-03-01T10:00:00+11:00", endAt: "2025-03-01T12:00:00+11:00" })
        .where(eq(events.id, EVENT_A));
      await db
        .update(events)
        .set({ startAt: "2025-04-20T10:00:00+11:00", endAt: "" })
        .where(eq(events.id, EVENT_B));
      const stamp = new Date("2025-04-21T00:00:00.000Z");
      await db.insert(registrySettings).values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        published: true,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await db.insert(registryContributions).values({
        id: "rct_d1_sweep",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: null,
        familyId: FAMILY_ID,
        status: "succeeded",
        amountMinor: 5_000,
        currency: "AUD",
        stripeCheckoutSessionId: "cs_d1_sweep",
        createdAt: stamp,
        updatedAt: stamp,
      });

      const seen: GiftSummaryNotice[] = [];
      const deleted = await run(
        retentionService.sweepExpiredGuestData(
          new Date("2026-06-17T04:00:00.000Z"),
          {},
          (notices) =>
            Effect.sync(() => {
              seen.push(...notices);
            }),
        ),
      );

      expect(deleted).toBe(2);
      expect(seen.map((n) => [n.weddingId, n.finalEventOn])).toEqual([
        [BOOTSTRAP_WEDDING_ID, "2025-04-20"],
      ]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "sets and reads the invite's section switches over async D1",
    async () => {
      await db.delete(weddingInviteCustomisations);
      // No row yet: every switch reads as on (the LEFT JOIN miss).
      expect((await run(inviteService.getForWeddingId(BOOTSTRAP_WEDDING_ID))).visibility).toEqual({
        hero: true,
        story: true,
        faq: true,
        footer: true,
      });

      // First write inserts the row; a section the body leaves out gets the
      // column default. A second write updates only what it names.
      await run(inviteService.setVisibility(BOOTSTRAP_WEDDING_ID, { story: false }));
      await run(inviteService.setVisibility(BOOTSTRAP_WEDDING_ID, { footer: false }));
      expect((await run(inviteService.getForWeddingId(BOOTSTRAP_WEDDING_ID))).visibility).toEqual({
        hero: true,
        story: false,
        faq: true,
        footer: false,
      });

      // The claim payload carries the closing section's switch.
      const claim = (await run(claimService.lookup(PUBLIC_ID))) as {
        closing?: { visible: boolean; message: string | null };
      };
      expect(claim.closing).toMatchObject({ visible: false, message: null });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "runs migration 0063's backfill on D1's own SQLite",
    async () => {
      // The suite builds its schema from the test DDL, which already has the
      // three columns, so only the migration's UPDATE statements are replayed
      // here: what is being proven is that D1 accepts them (`trim(X, char(...))`
      // included) and that they switch sections the way the emptiness checks do.
      const migration = readFileSync(
        join(import.meta.dir, "..", "..", "..", "db", "migrations", MIGRATION_0063),
        "utf8",
      );
      const updates = migration
        .split("--> statement-breakpoint")
        .map((chunk) =>
          chunk
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter((stmt) => stmt.startsWith("UPDATE"));
      expect(updates).toHaveLength(3);

      await db.delete(weddingInviteCustomisations);
      const stamp = new Date();
      await db.insert(weddings).values([
        {
          id: "wed_d1_blank",
          slug: "d1-blank",
          displayName: "Blank",
          ownerOsnProfileId: "usr_test",
          createdAt: stamp,
          updatedAt: stamp,
        },
        {
          id: "wed_d1_full",
          slug: "d1-full",
          displayName: "Full",
          ownerOsnProfileId: "usr_test",
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]);
      await db.insert(weddingInviteCustomisations).values([
        {
          weddingId: "wed_d1_blank",
          // Whitespace from both ends of JavaScript's trim set, and a label.
          heroTitle: " 　 ﻿",
          storyEyebrow: "Our Story",
          footerMessage: "\t\n",
          updatedAt: stamp,
        },
        {
          weddingId: "wed_d1_full",
          heroImageKey: "assets/wed_d1_full/hero-1",
          storyBody: " On a train.　",
          footerMessage: "No boxed gifts please",
          updatedAt: stamp,
        },
      ]);

      for (const stmt of updates) await d1.prepare(stmt).run();

      const rows = await db
        .select({
          weddingId: weddingInviteCustomisations.weddingId,
          hero: weddingInviteCustomisations.heroVisible,
          story: weddingInviteCustomisations.storyVisible,
          footer: weddingInviteCustomisations.footerVisible,
        })
        .from(weddingInviteCustomisations)
        .orderBy(asc(weddingInviteCustomisations.weddingId));
      expect(rows).toEqual([
        { weddingId: "wed_d1_blank", hero: false, story: false, footer: false },
        { weddingId: "wed_d1_full", hero: true, story: true, footer: true },
      ]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "adds, caps, changes, orders and deletes FAQ entries over async D1, and the claim carries them",
    async () => {
      await db.delete(weddingInviteCustomisations);
      const a = await run(
        inviteFaqService.create(BOOTSTRAP_WEDDING_ID, { question: " Parking? ", answer: "Yes." }),
      );
      const b = await run(
        inviteFaqService.create(BOOTSTRAP_WEDDING_ID, {
          question: "Children?",
          answer: "Ceremony.",
        }),
      );
      expect(a.question).toBe("Parking?");

      // The single-statement INSERT … SELECT … RETURNING binds its timestamps
      // itself; on D1 they must land in epoch seconds too.
      const [raw] = await db.all<{ created_at: number }>(
        sql`SELECT created_at FROM wedding_faqs WHERE id = ${a.id}`,
      );
      expect(Math.abs(raw!.created_at - Date.now() / 1000)).toBeLessThan(60);

      await run(
        inviteFaqService.update(BOOTSTRAP_WEDDING_ID, b.id, {
          question: "Are children invited?",
          answer: "To the ceremony.",
        }),
      );
      await run(inviteFaqService.reorder(BOOTSTRAP_WEDDING_ID, [b.id, a.id]));
      expect((await run(inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).map((e) => e.id)).toEqual([
        b.id,
        a.id,
      ]);

      // The claim carries them in order while the switch is on (no row ⇒ on)…
      const on = await run(claimService.lookup(PUBLIC_ID));
      expect(on.faq).toEqual({
        visible: true,
        entries: [
          { question: "Are children invited?", answer: "To the ceremony." },
          { question: "Parking?", answer: "Yes." },
        ],
      });

      // …and none once it is off, with the entries kept.
      await run(inviteService.setVisibility(BOOTSTRAP_WEDDING_ID, { faq: false }));
      expect((await run(claimService.lookup(PUBLIC_ID))).faq).toEqual({
        visible: false,
        entries: [],
      });
      expect(await run(inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).toHaveLength(2);

      await run(inviteFaqService.remove(BOOTSTRAP_WEDDING_ID, a.id));
      expect((await run(inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).map((e) => e.id)).toEqual([
        b.id,
      ]);

      // The cap is enforced by the INSERT itself, on D1 as on bun:sqlite.
      for (let i = 1; i < FAQ_LIMITS.maxEntries; i++) {
        await run(
          inviteFaqService.create(BOOTSTRAP_WEDDING_ID, { question: `Q${i}`, answer: "A" }),
        );
      }
      const refused = await Effect.runPromiseExit(
        inviteFaqService
          .create(BOOTSTRAP_WEDDING_ID, { question: "One more", answer: "No." })
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      if (Exit.isFailure(refused)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(refused.cause))).toBeInstanceOf(
          FaqLimitReached,
        );
      }
      expect(await run(inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).toHaveLength(
        FAQ_LIMITS.maxEntries,
      );
    },
    MF_TIMEOUT_MS,
  );

  it(
    "holds the FAQ cap when two adds race for the last place over async D1",
    async () => {
      for (let i = 0; i < FAQ_LIMITS.maxEntries - 1; i++) {
        await run(
          inviteFaqService.create(BOOTSTRAP_WEDDING_ID, { question: `Q${i}`, answer: "A" }),
        );
      }
      // Both in flight at once: a read-then-insert would let both counts see
      // 29 before either wrote. The count lives inside the INSERT, so one wins.
      const [first, second] = await Effect.runPromise(
        Effect.all(
          [
            Effect.exit(
              inviteFaqService.create(BOOTSTRAP_WEDDING_ID, { question: "Last A", answer: "A" }),
            ),
            Effect.exit(
              inviteFaqService.create(BOOTSTRAP_WEDDING_ID, { question: "Last B", answer: "B" }),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(DbService, db)),
      );
      const failures = [first, second].filter(Exit.isFailure);
      expect(failures).toHaveLength(1);
      expect(Option.getOrUndefined(Cause.findErrorOption(failures[0]!.cause))).toBeInstanceOf(
        FaqLimitReached,
      );
      expect(await run(inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).toHaveLength(
        FAQ_LIMITS.maxEntries,
      );
    },
    MF_TIMEOUT_MS,
  );

  it(
    "builds the schema from the migration chain, 0064 included, on D1's own SQLite",
    async () => {
      // Its own instance: the suite's shared database is built from the test
      // DDL, and replaying a migration into it would mean dropping a table every
      // later test needs. Here the whole chain runs from empty, in order, the
      // way `wrangler d1 migrations apply` runs it.
      const chainMf = new Miniflare({
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        d1Databases: { DB: ":memory:" },
      });
      try {
        const chainD1 = (await chainMf.getD1Database("DB")) as unknown as D1Database;
        const files = readdirSync(MIGRATIONS_DIR)
          .filter((f) => f.endsWith(".sql"))
          .toSorted();
        expect(files).toContain("0064_invite_faq.sql");
        for (const file of files) {
          for (const stmt of migrationStatements(file)) await chainD1.prepare(stmt).run();
        }

        const columns = await chainD1
          .prepare("PRAGMA table_info(wedding_invite_customisations)")
          .all<{ name: string; notnull: number; dflt_value: string | null }>();
        expect(columns.results.find((c) => c.name === "faq_visible")).toMatchObject({
          notnull: 1,
          dflt_value: "1",
        });

        // The service over the migrated database: an entry in, read back for
        // guests while the switch is at its default.
        const chainDb = createD1Db(createSessionRoutedClient(chainD1, "fetch"));
        const stamp = new Date();
        await chainDb.insert(weddings).values({
          id: "wed_chain",
          slug: "chain",
          displayName: "Chain",
          ownerOsnProfileId: "usr_test",
          createdAt: stamp,
          updatedAt: stamp,
        });
        await chainDb
          .insert(weddingInviteCustomisations)
          .values({ weddingId: "wed_chain", updatedAt: stamp });
        const created = await Effect.runPromise(
          inviteFaqService
            .create("wed_chain", { question: "Parking?", answer: "Yes." })
            .pipe(Effect.provideService(DbService, chainDb)),
        );
        const forGuests = await Effect.runPromise(
          inviteFaqService
            .listForGuests("wed_chain")
            .pipe(Effect.provideService(DbService, chainDb)),
        );
        expect(forGuests).toEqual([{ question: created.question, answer: created.answer }]);
      } finally {
        await chainMf.dispose();
      }
    },
    MF_TIMEOUT_MS,
  );
});
