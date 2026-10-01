import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  directoryVendorCategories,
  directoryVendors,
  events,
  families,
  guestAccountLinks,
  guestEvents,
  guests,
  hostRsvpNotices,
  registryClaims,
  registryContributions,
  registryItems,
  registrySettings,
  rsvpChanges,
  rsvps,
  tasks,
  vendorClaims,
  vendors,
  weddingFaqs,
  platformSales,
  weddingEntitlements,
  weddingInviteCustomisations,
  weddings,
  weddingUpgradePurchases,
  BOOTSTRAP_WEDDING_ID,
} from "@cire/db";
import { EmailService, type SendEmailInput } from "@shared/email";
import { asc, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Miniflare } from "miniflare";

import {
  createSessionRoutedClient,
  D1_SESSION_CONSTRAINT,
  runInD1Session,
  withD1Session,
} from "../../src/db/d1-session";
import { createD1Db, DbService } from "../../src/db/index";
import type { Db } from "../../src/db/index";
import { DDL } from "../../src/db/setup";
import type { ImportPlan } from "../../src/schemas/import";
import { FAQ_LIMITS } from "../../src/schemas/invite-faq";
import { PLUS_ONE_NAME_MAX, PLUS_ONE_REMOVALS_MAX } from "../../src/schemas/plus-one";
import {
  ChangeConflict,
  claimChanges,
  commitClaimStatement,
  headRevision,
} from "../../src/services/changes";
import { type AccountLinkGate, claimService } from "../../src/services/claim";
import {
  ClaimInvalid,
  createDirectoryService,
  OrgAlreadyHasListing,
} from "../../src/services/directory";
import { giftExportService } from "../../src/services/gift-export";
import { applyImport } from "../../src/services/import";
import { inviteService } from "../../src/services/invite";
import { FaqLimitReached, inviteFaqService } from "../../src/services/invite-faq";
import { organiserSessionService } from "../../src/services/organiser-session";
import { plusOneService } from "../../src/services/plus-one";
import {
  registryGuestService,
  registryService,
  SettingsChanged,
} from "../../src/services/registry";
import { type GiftSummaryNotice, retentionService } from "../../src/services/retention";
import { rsvpService } from "../../src/services/rsvp";
import { rsvpChangeService } from "../../src/services/rsvp-changes";
import { rsvpDigestService } from "../../src/services/rsvp-digest";
import type { StripeClient } from "../../src/services/stripe";
import { tasksService } from "../../src/services/tasks";
import { BASE_GUEST_CAP, tierService } from "../../src/services/tiers";
import { createUpgradeCatalogue } from "../../src/services/upgrade-catalogue";
import { createUpgradeService } from "../../src/services/upgrades";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// The rest of the suite runs on synchronous bun:sqlite; these exercise the
// ASYNCHRONOUS D1 driver path that production actually uses — the `dbQuery`
// bridge, awaited writes, and the `db.batch([...])` branch of `applyImport`
// (which bun:sqlite cannot reach). This is the only coverage of that path.

// Schema setup and FK-ordered truncation are inherently sequential here.
/* eslint-disable no-await-in-loop */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIGRATION_0063 = "0063_invite_section_visibility.sql";
const MIGRATION_0065 = "0065_invite_sections_switched_on.sql";
const MIGRATION_0073 = "0073_wedding_tiers.sql";

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
    vendorClaims,
    vendors,
    directoryVendorCategories,
    directoryVendors,
    rsvpChanges,
    hostRsvpNotices,
    rsvps,
    guestEvents,
    guests,
    families,
    events,
    tasks,
    registrySettings,
    weddingFaqs,
    platformSales,
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
    "claim.lookup reads the account-link state over D1, every query inside the session",
    async () => {
      const now = new Date();
      await db.insert(guestAccountLinks).values({
        id: "gal_d1",
        guestId: GUEST_2,
        familyId: FAMILY_ID,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnAccountId: "acc_d1",
        osnProfileId: "usr_d1",
        linkedAt: now,
        updatedAt: now,
      });
      const { token } = await run(
        organiserSessionService.create({
          osnProfileId: "usr_d1",
          osnSub: "pw_usr_d1",
          email: null,
          handle: null,
          displayName: null,
          avatarUrl: null,
        }),
      );

      // Record where every query goes: the session, or the raw binding the
      // routed client falls back to when a query escapes the request's context.
      const onBinding: string[] = [];
      const inSession: string[] = [];
      const fallback: Pick<D1Database, "prepare" | "batch"> = {
        prepare: (query) => {
          onBinding.push(query);
          return d1.prepare(query);
        },
        batch: (statements) => d1.batch(statements),
      };
      const raw = d1.withSession(D1_SESSION_CONSTRAINT);
      const session: Pick<D1Database, "prepare" | "batch"> = {
        prepare: (query) => {
          inSession.push(query);
          return raw.prepare(query);
        },
        batch: (statements) => raw.batch(statements),
      };
      const routed = createD1Db(createSessionRoutedClient(fallback, "fetch"));

      // The flag answers after a timer, as a payload refresh from the CDN would,
      // so the link reads start from a resumed fiber rather than in step.
      const gate: AccountLinkGate = {
        enabledFor: () => new Promise((resolve) => setTimeout(() => resolve(true), 20)),
        osnSessionToken: token,
      };
      const res = await withD1Session(session, () =>
        Effect.runPromise(
          claimService.lookup(PUBLIC_ID, gate).pipe(Effect.provideService(DbService, routed)),
        ),
      );

      expect(res.accountLink).toEqual({ enabled: true, signedIn: true, linkedGuestIds: [GUEST_2] });
      expect(res.members).toHaveLength(2);
      expect(inSession.some((q) => q.includes("guest_account_links"))).toBe(true);
      expect(inSession.some((q) => q.includes("organiser_sessions"))).toBe(true);
      expect(onBinding).toEqual([]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "claim.lookup never holds the events read for the account-linking flag",
    async () => {
      const inSession: string[] = [];
      const raw = d1.withSession(D1_SESSION_CONSTRAINT);
      const session: Pick<D1Database, "prepare" | "batch"> = {
        prepare: (query) => {
          inSession.push(query);
          return raw.prepare(query);
        },
        batch: (statements) => raw.batch(statements),
      };
      const routed = createD1Db(createSessionRoutedClient(d1, "fetch"));
      const eventsRead = () => inSession.some((q) => q.includes('from "events"'));

      // The flag answers only once the invite's events read has gone out. If
      // the account-link branch sat ahead of that read, the flag would never
      // answer in time and the payload would report linking off.
      const gate: AccountLinkGate = {
        enabledFor: () =>
          new Promise((resolve) => {
            let polls = 0;
            const poll = () => {
              if (eventsRead()) return resolve(true);
              if (++polls > 200) return resolve(false);
              setTimeout(poll, 5);
            };
            poll();
          }),
        osnSessionToken: null,
      };
      const res = await withD1Session(session, () =>
        Effect.runPromise(
          claimService.lookup(PUBLIC_ID, gate).pipe(Effect.provideService(DbService, routed)),
        ),
      );

      expect(eventsRead()).toBe(true);
      expect(res.accountLink).toEqual({ enabled: true, signedIn: false, linkedGuestIds: [] });
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
    "of two change claims at the same head on D1, one takes the wedding",
    async () => {
      const first = await run(claimChanges(BOOTSTRAP_WEDDING_ID, "0"));
      expect(first.rev).toBe(0);
      const second = await run(Effect.flip(claimChanges(BOOTSTRAP_WEDDING_ID, "0")));
      expect(second).toBeInstanceOf(ChangeConflict);
      expect(second.reason).toBe("in_progress");
    },
    MF_TIMEOUT_MS,
  );

  it(
    "a change whose claim was taken from it rolls back its final batch on D1",
    async () => {
      const claim = await run(claimChanges(BOOTSTRAP_WEDDING_ID, "0"));
      await db
        .update(weddings)
        .set({ changeClaim: "someone-else" })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID));
      const plan: ImportPlan = {
        eventCreates: [],
        eventUpdates: [],
        eventRemoves: [],
        familyCreates: [{ id: "fam_lost", publicId: "LOSTFAM-CC03", familyName: "Lost" }],
        familyUpdates: [],
        familyRemoves: [],
        guestCreates: [],
        guestUpdates: [],
        guestRemoves: [],
        eventLinkCreates: [],
        eventLinkRemoves: [],
        warnings: [],
      };

      const failure = await run(
        Effect.flip(
          applyImport("imp_lost", plan, BOOTSTRAP_WEDDING_ID, [commitClaimStatement(db, claim)]),
        ),
      );
      expect(failure._tag).toBe("ImportError");
      // The household rode in the same batch as the failed commit statement.
      expect(await db.select().from(families).where(eq(families.id, "fam_lost"))).toHaveLength(0);
      const [row] = await db
        .select({ rev: weddings.changeRev, claim: weddings.changeClaim })
        .from(weddings)
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID));
      expect(row).toEqual({ rev: 0, claim: "someone-else" });

      // Held by its own token, the same statement commits and moves the head.
      await db
        .update(weddings)
        .set({ changeClaim: claim.token })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID));
      await run(
        applyImport("imp_kept", plan, BOOTSTRAP_WEDDING_ID, [commitClaimStatement(db, claim)]),
      );
      expect(await db.select().from(families).where(eq(families.id, "fam_lost"))).toHaveLength(1);
      expect(await run(headRevision(BOOTSTRAP_WEDDING_ID))).toBe("1");
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
    "guest registry gate: one joined read decides the list, and the image, on D1",
    async () => {
      // The correlated EXISTS columns and the LEFT JOIN's NULL settings run
      // through the D1 driver's positional row mapping here, not only through
      // bun:sqlite's.
      const now = new Date();
      const visible = (eff: Effect.Effect<string, unknown, DbService>) =>
        Effect.runPromiseExit(eff.pipe(Effect.provideService(DbService, db)));
      await db.update(weddings).set({ tier: "gold" }).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID));
      // On Gold, never opened: no settings row reads as unpublished.
      expect(Exit.isFailure(await visible(registryGuestService.visibleWeddingId("w")))).toBe(true);

      await db.insert(registrySettings).values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        published: true,
        headline: "Gifts",
        createdAt: now,
        updatedAt: now,
      });
      expect(await run(registryGuestService.visibleWeddingId("w"))).toBe(BOOTSTRAP_WEDDING_ID);
      const view = await run(registryGuestService.guestView({ slug: "w", familyId: FAMILY_ID }));
      expect(view.headline).toBe("Gifts");
      expect(view.cashGiftsEnabled).toBe(false);

      await db.insert(registryItems).values({
        id: "ritem_gate",
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Copper Pan",
        imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/registry-d1`,
        createdAt: now,
        updatedAt: now,
      });
      expect(await run(registryGuestService.visibleImageKey("w", "registry-d1"))).toBe(
        `assets/${BOOTSTRAP_WEDDING_ID}/registry-d1`,
      );
      expect(
        Exit.isFailure(await visible(registryGuestService.visibleImageKey("w", "registry-gone"))),
      ).toBe(true);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "gift log pages through one union with an offset on D1",
    async () => {
      const at = (seconds: number) => new Date(Date.UTC(2026, 7, 20, 10, 0, seconds));
      await db.insert(registryItems).values({
        id: "ritem_log",
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Copper Pan",
        createdAt: at(0),
        updatedAt: at(0),
      });
      // The oldest gift is a claim; 51 cash gifts follow it, a second apart.
      await db.insert(registryClaims).values({
        id: "rclaim_log",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "ritem_log",
        familyId: FAMILY_ID,
        quantity: 1,
        status: "reserved",
        createdAt: at(0),
        updatedAt: at(0),
      });
      // Ten rows per insert: D1 binds at most 100 variables per statement.
      for (let start = 1; start <= 51; start += 10) {
        await db.insert(registryContributions).values(
          Array.from({ length: Math.min(10, 52 - start) }, (_, i) => ({
            id: `rcon_log_${String(start + i).padStart(2, "0")}`,
            weddingId: BOOTSTRAP_WEDDING_ID,
            itemId: null,
            familyId: FAMILY_ID,
            status: "succeeded" as const,
            amountMinor: 1_000,
            currency: "AUD",
            createdAt: at(start + i),
            updatedAt: at(start + i),
          })),
        );
      }

      const first = await run(registryService.giftLog(BOOTSTRAP_WEDDING_ID));
      expect(first.entries).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      expect(first.entries[0]!.id).toBe("rcon_log_51");

      const second = await run(registryService.giftLog(BOOTSTRAP_WEDDING_ID, { offset: 50 }));
      expect(second.hasMore).toBe(false);
      expect(second.entries.map((e) => [e.kind, e.id, e.quantity, e.amountMinor])).toEqual([
        ["contribution", "rcon_log_01", null, 1_000],
        ["claim", "rclaim_log", 1, null],
      ]);
      expect(second.entries[1]!.createdAt).toBe(at(0).getTime());
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
      // The wedding's CRM links dv_two only.
      await db.insert(vendors).values({
        id: "ven_two",
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: "dv_two",
        name: "Two Categories",
        category: "venue",
        createdAt: now,
        updatedAt: now,
      });
      const directory = createDirectoryService();

      const two = await run(directory.getLiveListingById("dv_two", BOOTSTRAP_WEDDING_ID));
      expect(two?.name).toBe("Two Categories");
      expect(two?.createdAt).toBe(Math.floor(now.getTime() / 1000) * 1000);
      expect(two?.categories.toSorted()).toEqual(["catering", "venue"]);
      // D1 returns the EXISTS as an integer; the service hands back a boolean.
      expect(two?.inWedding).toBe(true);

      const none = await run(directory.getLiveListingById("dv_none", BOOTSTRAP_WEDDING_ID));
      expect(none?.categories).toEqual([]);
      expect(none?.inWedding).toBe(false);

      expect(await run(directory.getLiveListingById("dv_draft", BOOTSTRAP_WEDDING_ID))).toBeNull();
      expect(
        await run(directory.getLiveListingById("dv_missing", BOOTSTRAP_WEDDING_ID)),
      ).toBeNull();
    },
    MF_TIMEOUT_MS,
  );

  it(
    "consumeClaim burns the token and binds the listing from the bind's RETURNING row",
    async () => {
      const now = new Date();
      await db.insert(vendors).values({
        id: "ven_claim",
        weddingId: BOOTSTRAP_WEDDING_ID,
        name: "Claim Florals",
        category: "florals",
        createdAt: now,
        updatedAt: now,
      });
      const directory = createDirectoryService();
      const { claimToken, directoryVendorId } = await run(
        directory.seedFromCrm(BOOTSTRAP_WEDDING_ID, "ven_claim", {
          name: "Claim Florals",
          description: null,
          email: "claim@example.com",
          phone: null,
          website: null,
          instagram: null,
          locationText: null,
          priceBand: null,
          priceMinMinor: null,
          priceMaxMinor: null,
          categories: ["florals", "decor_styling"],
        }),
      );

      // A second live token for the same listing, as a couple's enquiry mints.
      const second = await run(
        directory.issueClaimForListing({
          id: directoryVendorId,
          ownerOrgId: null,
          email: "claim@example.com",
          name: "Claim Florals",
          phone: null,
          claimedByProfileId: null,
          leadForwardEmail: null,
        }),
      );
      expect(second).not.toBeNull();

      const listing = await run(directory.consumeClaim(claimToken, "org_claim", "usr_claim"));
      expect(listing.id).toBe(directoryVendorId);
      expect(listing.ownerOrgId).toBe("org_claim");
      expect(listing.listed).toBe("live");
      expect(listing.categories.toSorted()).toEqual(["decor_styling", "florals"]);

      const [row] = await db
        .select()
        .from(directoryVendors)
        .where(eq(directoryVendors.id, directoryVendorId));
      expect(row?.claimedByProfileId).toBe("usr_claim");
      // The bind's batch burned the listing's other token too.
      const claims = await db
        .select()
        .from(vendorClaims)
        .where(eq(vendorClaims.directoryVendorId, directoryVendorId));
      expect(claims).toHaveLength(2);
      expect(claims.every((c) => c.consumedAt !== null)).toBe(true);
      const late = await Effect.runPromiseExit(
        directory
          .consumeClaim(second!.claimToken, "org_late", "usr_late")
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(
        Exit.isFailure(late) &&
          Option.getOrUndefined(Cause.findErrorOption(late.cause)) instanceof ClaimInvalid,
      ).toBe(true);

      const reuse = await Effect.runPromiseExit(
        directory
          .consumeClaim(claimToken, "org_other", "usr_other")
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(
        Exit.isFailure(reuse) &&
          Option.getOrUndefined(Cause.findErrorOption(reuse.cause)) instanceof ClaimInvalid,
      ).toBe(true);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "consumeClaim refuses an org that already owns a listing, and the owner index is unique",
    async () => {
      const now = new Date();
      const directory = createDirectoryService();
      const base = { listed: "live", createdAt: now, updatedAt: now };
      await db.insert(directoryVendors).values([
        { id: "dv_owned", ownerOrgId: "org_owner", name: "Owned", ...base },
        { id: "dv_open", ownerOrgId: null, name: "Open", ...base },
      ]);
      const claim = await run(
        directory.issueClaimForListing({
          id: "dv_open",
          ownerOrgId: null,
          email: "open@example.com",
          name: "Open",
          phone: null,
          claimedByProfileId: null,
          leadForwardEmail: null,
        }),
      );

      const refused = await Effect.runPromiseExit(
        directory
          .consumeClaim(claim!.claimToken, "org_owner", "usr_owner")
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(
        Exit.isFailure(refused) &&
          Option.getOrUndefined(Cause.findErrorOption(refused.cause)) instanceof
            OrgAlreadyHasListing,
      ).toBe(true);
      const [open] = await db
        .select()
        .from(vendorClaims)
        .where(eq(vendorClaims.directoryVendorId, "dv_open"));
      expect(open?.consumedAt).toBeNull();

      // The unique owner index, on D1's own SQLite: a second owned row fails.
      // ddl-lockstep.test.ts checks that migration 0072 builds the same index.
      await expect(
        db
          .insert(directoryVendors)
          .values({ id: "dv_dup", ownerOrgId: "org_owner", name: "Dup", ...base })
          .run(),
      ).rejects.toThrow();
    },
    MF_TIMEOUT_MS,
  );

  it(
    "upsertListingForOrg answers an update from the UPDATE's RETURNING row",
    async () => {
      const directory = createDirectoryService();
      const body = {
        name: "Upsert Cakes",
        description: null,
        email: "cakes@example.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: "Hobart",
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["cake"],
      };
      const first = await run(directory.upsertListingForOrg("org_upsert", body));
      const second = await run(
        directory.upsertListingForOrg("org_upsert", {
          ...body,
          name: "Upsert Cakes Renamed",
          categories: ["venue", "cake"],
        }),
      );

      expect(second.id).toBe(first.id);
      expect(second.name).toBe("Upsert Cakes Renamed");
      expect(second.locationText).toBe("Hobart");
      // Stored at second precision; the first save answers from memory.
      expect(second.createdAt).toBe(Math.floor(first.createdAt / 1000) * 1000);
      expect(second.categories).toEqual(["cake", "venue"]);
      const stored = await db
        .select({ category: directoryVendorCategories.category })
        .from(directoryVendorCategories)
        .where(eq(directoryVendorCategories.directoryVendorId, second.id));
      expect(stored.map((r) => r.category).toSorted()).toEqual(second.categories);

      // A repeated category fails the replace batch on its primary key, and
      // the batch commits nothing: the stored set is the one saved above.
      const dup = await Effect.runPromiseExit(
        directory
          .upsertListingForOrg("org_upsert", { ...body, categories: ["florals", "florals"] })
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(Exit.isFailure(dup)).toBe(true);
      const after = await db
        .select({ category: directoryVendorCategories.category })
        .from(directoryVendorCategories)
        .where(eq(directoryVendorCategories.directoryVendorId, second.id));
      expect(after.map((r) => r.category).toSorted()).toEqual(["cake", "venue"]);
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
    "a double submit over D1 names one plus-one and copies the inviter's invitations once",
    async () => {
      await db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.id, GUEST_1));
      // Both calls may read "no plus-one yet" before either writes: the loser's
      // guest insert is skipped by the one-per-guest index, and its invitation
      // copy — which reaches the new id only through that row — copies nothing
      // instead of failing the batch on a foreign key.
      const results = await Promise.all([
        run(plusOneService.save(FAMILY_ID, GUEST_1, { firstName: "Sam", lastName: "" })),
        run(plusOneService.save(FAMILY_ID, GUEST_1, { firstName: "Sam", lastName: "" })),
      ]);
      const rows = await db.select().from(guests).where(eq(guests.plusOneOfGuestId, GUEST_1));
      expect(rows).toHaveLength(1);
      expect(results.map((r) => r.plusOne.guestId)).toEqual([rows[0]!.id, rows[0]!.id]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const links = await db
        .select({ eventId: guestEvents.eventId })
        .from(guestEvents)
        .where(eq(guestEvents.guestId, rows[0]!.id));
      expect(links.map((l) => l.eventId).toSorted()).toEqual([EVENT_A, EVENT_B]);
      // The change row rides the batch that names them, so the skipped submit
      // logs nothing.
      const logged = await db
        .select({ guestId: rsvpChanges.guestId, kind: rsvpChanges.kind })
        .from(rsvpChanges);
      expect(logged).toEqual([{ guestId: GUEST_1, kind: "plus_one_added" }]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "two households naming plus-ones at once over D1 cannot pass the guest cap",
    async () => {
      // One place left under the cap. Each inviter is a different guest, so the
      // one-per-guest index cannot stop the second insert: only a cap check
      // inside the write can.
      const now = new Date();
      await db.insert(families).values({
        id: "fam_fill",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "FILL-0001",
        familyName: "Filler",
        createdAt: now,
        updatedAt: now,
      });
      const filler = Array.from({ length: BASE_GUEST_CAP - 3 }, (_, i) => ({
        id: `g_fill_${i}`,
        familyId: "fam_fill",
        firstName: `Filler${i}`,
        createdAt: now,
        updatedAt: now,
      }));
      // Under D1's 100-parameter statement limit.
      for (let i = 0; i < filler.length; i += 10) {
        await db.insert(guests).values(filler.slice(i, i + 10));
      }
      await db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.familyId, FAMILY_ID));

      const outcomes = await Promise.all(
        [GUEST_1, GUEST_2].map((inviter) =>
          run(
            plusOneService
              .save(FAMILY_ID, inviter, { firstName: `Plus ${inviter}`, lastName: "" })
              .pipe(
                Effect.match({
                  onFailure: (e) => e._tag,
                  onSuccess: (r) => (r.created ? "created" : "not created"),
                }),
              ),
          ),
        ),
      );

      const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(guests);
      expect(n).toBe(BASE_GUEST_CAP);
      expect(outcomes.toSorted()).toEqual(["CapacityExceeded", "created"]);
      // The loser's batch copied no invitation either: only the winner's
      // plus-one exists, with its inviter's invitations and nothing more.
      const named = await db
        .select({ id: guests.id, of: guests.plusOneOfGuestId })
        .from(guests)
        .where(sql`${guests.plusOneOfGuestId} IS NOT NULL`);
      expect(named).toHaveLength(1);
      const links = await db
        .select({ guestId: guestEvents.guestId })
        .from(guestEvents)
        .where(eq(guestEvents.guestId, named[0]!.id));
      expect(links).toHaveLength(named[0]!.of === GUEST_1 ? 2 : 1);
      const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(guestEvents);
      expect(total).toBe(3 + links.length);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "a plus-one's attested reply reads back current over D1, and a household rename clears it",
    async () => {
      await db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.id, GUEST_1));
      const named = await run(
        plusOneService.save(FAMILY_ID, GUEST_1, { firstName: "Sam", lastName: "" }),
      );
      const samId = named.plusOne.guestId;
      const dietary = { dietary: "", dietaryPresets: ["nuts"] as const, dietaryConsent: true };

      // The read-back rides as the trailing statement of the real batch, cast
      // to its row type: the join columns it reads to answer "current" must
      // not leak into what the invite receives.
      const rows = await run(
        rsvpService.submitRsvpsAndList(
          [
            {
              guestId: samId,
              eventId: EVENT_A,
              status: "attending",
              ...dietary,
              consentSource: "inviter_attested",
            },
            {
              guestId: GUEST_2,
              eventId: EVENT_A,
              status: "attending",
              ...dietary,
              consentSource: "organiser_attested",
            },
          ],
          FAMILY_ID,
        ),
      );
      const sam = rows.find((r) => r.guestId === samId);
      expect(sam?.dietaryConsentCurrent).toBe(true);
      expect(rows.find((r) => r.guestId === GUEST_2)?.dietaryConsentCurrent).toBe(false);
      expect(Object.keys(sam ?? {}).toSorted()).toEqual(
        [
          "dietary",
          "dietaryConsentCurrent",
          "dietaryPresets",
          "eventId",
          "guestId",
          "status",
        ].toSorted(),
      );

      // Renamed by the household: the old person's answers and the
      // attestation go in the same batch as the name.
      const renamed = await run(
        plusOneService.save(FAMILY_ID, GUEST_1, { firstName: "Alex", lastName: "" }),
      );
      expect(renamed).toMatchObject({ created: false, dietaryCleared: true });
      const [stored] = await db.select().from(rsvps).where(eq(rsvps.guestId, samId));
      expect(stored).toMatchObject({
        status: "attending",
        dietary: "",
        dietaryPresets: "",
        dietaryConsentVersion: null,
        dietaryConsentAt: null,
      });
      const [guest] = await db.select().from(guests).where(eq(guests.id, samId));
      expect(guest?.firstName).toBe("Alex");
    },
    MF_TIMEOUT_MS,
  );

  it(
    "the retention sweep counts a plus-one once, cascade or not",
    async () => {
      await db
        .update(events)
        .set({ startAt: "2025-03-01T10:00:00+11:00", endAt: "2025-03-01T12:00:00+11:00" });
      const now = new Date();
      await db.insert(guests).values({
        id: "g_plus",
        familyId: FAMILY_ID,
        firstName: "Sam",
        sortOrder: 0,
        source: "manual",
        plusOneOfGuestId: GUEST_1,
        createdAt: now,
        updatedAt: now,
      });
      const deleted = await run(
        retentionService.sweepExpiredGuestData(new Date("2026-06-17T04:00:00.000Z")),
      );
      expect(deleted).toBe(3);
      expect(await db.select().from(guests)).toEqual([]);
    },
    MF_TIMEOUT_MS,
  );

  /** A plus-one of `inviterId` in the test household, invited to the inviter's
   *  events and with a reply, so a delete of them has a cascade to take. */
  async function seedPlusOneOnD1(
    id: string,
    inviterId: string,
    name: { firstName: string; lastName: string },
  ): Promise<void> {
    const now = new Date();
    await db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.id, inviterId));
    await db.insert(guests).values({
      id,
      familyId: FAMILY_ID,
      ...name,
      sortOrder: 0,
      source: "manual",
      plusOneOfGuestId: inviterId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(guestEvents).values({ guestId: id, eventId: EVENT_A });
    await db.insert(rsvps).values({
      id: `r_${id}`,
      guestId: id,
      eventId: EVENT_A,
      status: "attending",
      consentSource: "inviter_attested",
      createdAt: now,
    });
  }

  const householdOff = (
    removePlusOnes: { guestId: string; firstName: string; lastName: string }[],
  ) =>
    plusOneService.setHouseholdPermission({
      weddingId: BOOTSTRAP_WEDDING_ID,
      familyId: FAMILY_ID,
      allowed: false,
      removePlusOnes,
    });

  it(
    "a confirmed household removal over D1 deletes the plus-ones and counts them, not their cascade",
    async () => {
      await seedPlusOneOnD1("g_sam", GUEST_1, { firstName: "Sam", lastName: "Lee" });
      await seedPlusOneOnD1("g_pat", GUEST_2, { firstName: "Pat", lastName: "" });

      const result = await run(
        householdOff([
          { guestId: "g_sam", firstName: "Sam", lastName: "Lee" },
          { guestId: "g_pat", firstName: "Pat", lastName: "" },
        ]),
      );
      expect(result).toEqual({
        familyId: FAMILY_ID,
        plusOneAllowed: false,
        guestsUpdated: 2,
        plusOnesRemoved: 2,
      });
      const left = await db.select({ id: guests.id, allowed: guests.plusOneAllowed }).from(guests);
      expect(left.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: GUEST_1, allowed: false },
        { id: GUEST_2, allowed: false },
      ]);
      expect(await db.select().from(rsvps)).toEqual([]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "a household removal over D1 whose plus-one was renamed since writes nothing",
    async () => {
      await seedPlusOneOnD1("g_sam", GUEST_1, { firstName: "Sam", lastName: "Lee" });
      await seedPlusOneOnD1("g_pat", GUEST_2, { firstName: "Pat", lastName: "" });
      await db.update(guests).set({ firstName: "Kit" }).where(eq(guests.id, "g_pat"));

      const exit = await Effect.runPromiseExit(
        householdOff([
          { guestId: "g_sam", firstName: "Sam", lastName: "Lee" },
          { guestId: "g_pat", firstName: "Pat", lastName: "" },
        ]).pipe(Effect.provideService(DbService, db)),
      );
      expect(
        Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
      ).toMatchObject({ _tag: "PlusOneNamed", named: 2 });
      const rows = await db
        .select({ id: guests.id, allowed: guests.plusOneAllowed })
        .from(guests)
        .where(eq(guests.familyId, FAMILY_ID));
      expect(rows.map((r) => r.id).toSorted()).toEqual(
        [GUEST_1, GUEST_2, "g_pat", "g_sam"].toSorted(),
      );
      expect(rows.filter((r) => r.id === GUEST_1 || r.id === GUEST_2).every((r) => r.allowed)).toBe(
        true,
      );
    },
    MF_TIMEOUT_MS,
  );

  it(
    "a confirmed removal over D1 takes the largest list the body allows",
    async () => {
      await seedPlusOneOnD1("g_sam", GUEST_1, { firstName: "Sam", lastName: "Lee" });
      await seedPlusOneOnD1("g_pat", GUEST_2, { firstName: "Pat", lastName: "" });
      const long = "x".repeat(PLUS_ONE_NAME_MAX);
      // The two real plus-ones, then filler at every field's longest, so the
      // one bound `json_each` parameter is as large as the schema lets it be.
      const filler = Array.from({ length: PLUS_ONE_REMOVALS_MAX - 2 }, (_, i) => ({
        guestId: `${i}`.padStart(64, "g"),
        firstName: long,
        lastName: long,
      }));
      const result = await run(
        householdOff([
          { guestId: "g_sam", firstName: "Sam", lastName: "Lee" },
          { guestId: "g_pat", firstName: "Pat", lastName: "" },
          ...filler,
        ]),
      );
      expect(result.plusOnesRemoved).toBe(2);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "one guest's confirmed removal over D1, under a name JSON has to escape",
    async () => {
      const name = { firstName: 'Jo "JJ" Zoë', lastName: "back\\slash 🎉" };
      await seedPlusOneOnD1("g_jo", GUEST_1, name);
      const result = await run(
        plusOneService.setGuestPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: GUEST_1,
          allowed: false,
          removePlusOnes: [{ guestId: "g_jo", ...name }],
        }),
      );
      expect(result).toEqual({ guestId: GUEST_1, plusOneAllowed: false, plusOneRemoved: true });
      expect(await db.select().from(guests).where(eq(guests.id, "g_jo"))).toEqual([]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "turning one guest off over D1 is refused inside the write while their plus-one is named",
    async () => {
      await seedPlusOneOnD1("g_sam", GUEST_1, { firstName: "Sam", lastName: "Lee" });
      const exit = await Effect.runPromiseExit(
        plusOneService
          .setGuestPermission({
            weddingId: BOOTSTRAP_WEDDING_ID,
            guestId: GUEST_1,
            allowed: false,
            removePlusOnes: [],
          })
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(
        Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
      ).toMatchObject({ _tag: "PlusOneNamed", named: 1 });
      const [inviter] = await db
        .select({ allowed: guests.plusOneAllowed })
        .from(guests)
        .where(eq(guests.id, GUEST_1));
      expect(inviter?.allowed).toBe(true);
      expect(await db.select().from(guests).where(eq(guests.id, "g_sam"))).toHaveLength(1);
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
      // column default. A second write updates only what it names. Each write
      // answers from the row its RETURNING clause handed back, which on D1
      // comes through the driver's raw path — so it must equal the next read,
      // booleans included.
      const inserted = await run(
        inviteService.setVisibility(BOOTSTRAP_WEDDING_ID, "w", { story: false }),
      );
      expect(inserted.visibility).toEqual({ hero: true, story: false, faq: true, footer: true });
      const updated = await run(
        inviteService.setVisibility(BOOTSTRAP_WEDDING_ID, "w", { footer: false }),
      );
      expect(updated).toEqual(await run(inviteService.getForWeddingId(BOOTSTRAP_WEDDING_ID)));
      expect(updated.visibility).toEqual({
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
    "runs migration 0065 on D1's own SQLite: every section on, the FAQ switch kept",
    async () => {
      const statements = migrationStatements(MIGRATION_0065);
      expect(statements).toHaveLength(1);

      await db.delete(weddingInviteCustomisations);
      const stamp = new Date();
      await db.insert(weddings).values([
        {
          id: "wed_d1_off",
          slug: "d1-off",
          displayName: "Off",
          ownerOsnProfileId: "usr_test",
          createdAt: stamp,
          updatedAt: stamp,
        },
        {
          id: "wed_d1_on",
          slug: "d1-on",
          displayName: "On",
          ownerOsnProfileId: "usr_test",
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]);
      await db.insert(weddingInviteCustomisations).values([
        {
          weddingId: "wed_d1_off",
          heroVisible: false,
          storyVisible: false,
          footerVisible: false,
          faqVisible: false,
          updatedAt: stamp,
        },
        { weddingId: "wed_d1_on", faqVisible: false, updatedAt: stamp },
      ]);

      const result = await d1.prepare(statements[0]!).run();
      // Only the row with a switch off is written.
      expect(result.meta.changes).toBe(1);

      const rows = await db
        .select({
          weddingId: weddingInviteCustomisations.weddingId,
          hero: weddingInviteCustomisations.heroVisible,
          story: weddingInviteCustomisations.storyVisible,
          footer: weddingInviteCustomisations.footerVisible,
          faq: weddingInviteCustomisations.faqVisible,
        })
        .from(weddingInviteCustomisations)
        .orderBy(asc(weddingInviteCustomisations.weddingId));
      expect(rows).toEqual([
        { weddingId: "wed_d1_off", hero: true, story: true, footer: true, faq: false },
        { weddingId: "wed_d1_on", hero: true, story: true, footer: true, faq: false },
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
      await run(inviteService.setVisibility(BOOTSTRAP_WEDDING_ID, "w", { faq: false }));
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

  it(
    "writes a 200-row change log inside the RSVP batch as one statement",
    async () => {
      // The change set rides as one JSON parameter; a per-row bind would pass
      // D1's 100-parameter cap long before 200 rows.
      const changes = Array.from({ length: 200 }, (_, i) => ({
        guestId: `g_${i}`,
        eventId: EVENT_A,
        kind: "reply_new" as const,
      }));
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
          ],
          FAMILY_ID,
          { weddingId: BOOTSTRAP_WEDDING_ID, changes },
        ),
      );
      expect(rows).toHaveLength(1);
      const logged = await db.select({ seq: rsvpChanges.seq }).from(rsvpChanges);
      expect(logged).toHaveLength(200);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "never reuses a change number after the newest row is deleted",
    async () => {
      const insert = () =>
        db
          .insert(rsvpChanges)
          .values({
            weddingId: BOOTSTRAP_WEDDING_ID,
            familyId: FAMILY_ID,
            guestId: GUEST_1,
            eventId: EVENT_A,
            kind: "reply_new",
            createdAt: new Date(),
          })
          .returning({ seq: rsvpChanges.seq });
      const [first] = await insert();
      const [second] = await insert();
      await db.delete(rsvpChanges).where(eq(rsvpChanges.seq, second!.seq));
      const [third] = await insert();
      expect(second!.seq).toBeGreaterThan(first!.seq);
      expect(third!.seq).toBeGreaterThan(second!.seq);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "reads the card's summary and the table's rows from real changes",
    async () => {
      const at = new Date("2026-09-20T10:00:00Z");
      const change = (
        guestId: string,
        eventId: string | null,
        kind: "reply_new" | "plus_one_added",
      ) => ({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: FAMILY_ID,
        guestId,
        eventId,
        kind,
        createdAt: at,
      });
      await db
        .insert(rsvpChanges)
        .values([
          change(GUEST_1, EVENT_A, "reply_new"),
          change(GUEST_2, EVENT_B, "reply_new"),
          change(GUEST_1, null, "plus_one_added"),
        ]);
      const newest = await db.select({ seq: rsvpChanges.seq }).from(rsvpChanges);

      const feed = await run(rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, "usr_b"));
      expect(feed.households).toBe(1);
      expect(feed.truncated).toBe(false);
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0]!.kinds).toEqual(["reply_new", "plus_one_added"]);
      expect(feed.items[0]!.at).toEqual(at);

      const table = await run(rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, "usr_b"));
      expect(table.rows).toEqual([
        { guestId: GUEST_1, eventId: EVENT_A },
        { guestId: GUEST_2, eventId: EVENT_B },
        { guestId: GUEST_1, eventId: null },
      ]);
      expect(table.markSeq).toBe(Math.max(...newest.map((r) => r.seq)));
    },
    MF_TIMEOUT_MS,
  );

  it(
    "moves a read marker, clamped and never backwards, and flips the digest switch",
    async () => {
      await db.insert(rsvpChanges).values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: FAMILY_ID,
        guestId: GUEST_1,
        eventId: EVENT_A,
        kind: "reply_new",
        createdAt: new Date(),
      });
      const [newest] = await db.select({ seq: rsvpChanges.seq }).from(rsvpChanges);
      expect(await run(rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, "usr_a", 1e9))).toBe(
        newest!.seq,
      );
      expect(await run(rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, "usr_a", 0))).toBe(
        newest!.seq,
      );
      const feed = await run(rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, "usr_a"));
      expect(feed.households).toBe(0);

      await run(rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, "usr_a", false));
      await run(rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, "usr_a", true));
      const [notice] = await db
        .select()
        .from(hostRsvpNotices)
        .where(eq(hostRsvpNotices.osnProfileId, "usr_a"));
      expect(notice).toMatchObject({ digestEnabled: true, digestSeq: newest!.seq });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "sends the daily digest and records its markers in one upsert",
    async () => {
      await db.insert(rsvpChanges).values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: FAMILY_ID,
        guestId: GUEST_1,
        eventId: EVENT_A,
        kind: "reply_new",
        createdAt: new Date(),
      });
      const sent: SendEmailInput[] = [];
      const layer = Layer.succeed(EmailService, {
        send: (input: SendEmailInput) => Effect.sync(() => void sent.push(input)),
      });
      const digest = () =>
        Effect.runPromise(
          rsvpDigestService
            .sendDailyDigests({
              organiserOrigin: "https://host.example.test",
              lookup: async (ids) => ({
                answered: true,
                emails: new Map(ids.map((id) => [id, `${id}@example.test`])),
              }),
            })
            .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
        );
      expect((await digest()).sent).toBe(1);
      expect(sent.map((s) => s.to)).toEqual(["usr_test@example.test"]);
      // The marker landed, so the same change is not mailed twice.
      expect((await digest()).sent).toBe(0);
      const [notice] = await db.select().from(hostRsvpNotices);
      expect(notice).toMatchObject({ osnProfileId: "usr_test", digestEnabled: true, seenSeq: 0 });
    },
    MF_TIMEOUT_MS,
  );
  it(
    "runs migration 0073's data statements on D1's own SQLite",
    async () => {
      // The schema comes from the test DDL, which already has the tier columns
      // and the narrowed index, so only the migration's UPDATEs are replayed:
      // what is proven is that D1 accepts them (`unixepoch()` included) and
      // that they lift each wedding to the tier its legacy rows paid for.
      const updates = migrationStatements(MIGRATION_0073).filter((stmt) =>
        stmt.startsWith("UPDATE"),
      );
      expect(updates).toHaveLength(3);

      const stamp = new Date(1_790_000_000_000);
      const lifted = [
        ["wed_d1_vendors", "vendors"],
        ["wed_d1_registry", "registry"],
        ["wed_d1_both", "registry"],
        ["wed_d1_both", "capacity_1000"],
        ["wed_d1_templates", "premium_templates"],
      ] as const;
      for (const id of new Set(lifted.map(([w]) => w))) {
        await db.insert(weddings).values({
          id,
          slug: id,
          displayName: id,
          ownerOsnProfileId: "usr_test",
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      for (const [weddingId, entitlement] of lifted) {
        await db.insert(weddingEntitlements).values({
          weddingId,
          entitlement,
          source: "comp",
          grantedAt: stamp,
          grantedBy: "usr_test",
        });
      }
      await db.insert(weddingUpgradePurchases).values({
        id: "upg_d1_legacy",
        weddingId: "wed_d1_vendors",
        entitlement: "vendors",
        status: "pending",
        createdByOsnProfileId: "usr_test",
        createdAt: stamp,
        updatedAt: stamp,
      });

      for (const stmt of updates) await d1.prepare(stmt).run();

      const tiers = await db
        .select({ id: weddings.id, tier: weddings.tier, source: weddings.tierSource })
        .from(weddings)
        .where(sql`${weddings.id} LIKE 'wed_d1_%'`)
        .orderBy(asc(weddings.id));
      expect(tiers).toEqual([
        { id: "wed_d1_both", tier: "crimson", source: "migration" },
        { id: "wed_d1_registry", tier: "gold", source: "migration" },
        { id: "wed_d1_templates", tier: "ivory", source: null },
        { id: "wed_d1_vendors", tier: "crimson", source: "migration" },
      ]);
      const [purchase] = await db
        .select({
          status: weddingUpgradePurchases.status,
          updatedAt: weddingUpgradePurchases.updatedAt,
        })
        .from(weddingUpgradePurchases)
        .where(eq(weddingUpgradePurchases.id, "upg_d1_legacy"));
      expect(purchase?.status).toBe("expired");
      expect(purchase!.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
    },
    MF_TIMEOUT_MS,
  );

  it(
    "settles an upgrade on D1: the tier grant, the sale and the flip in one batch",
    async () => {
      // The grant is an UPDATE of `weddings` riding in the same D1 batch as the
      // sales insert and the RETURNING flip, read back through D1's row
      // mapping — the shape bun:sqlite chains instead of batching.
      const stripe = {} as StripeClient;
      const upgrades = createUpgradeService({
        stripe,
        catalogue: createUpgradeCatalogue({ stripe, prices: {} }),
      });
      const now = new Date();
      await db.insert(weddingUpgradePurchases).values({
        id: "upg_d1",
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "crimson",
        fromTier: "ivory",
        status: "pending",
        checkoutSessionId: "cs_d1",
        createdByOsnProfileId: "usr_test",
        createdAt: now,
        updatedAt: now,
      });
      const settle = () =>
        run(
          upgrades.settlePurchase({
            purchaseId: "upg_d1",
            checkoutSessionId: "cs_d1",
            paid: true,
            paidAmountMinor: 9900,
            paidCurrency: "aud",
            paymentIntentId: "pi_d1",
          }),
        );

      expect(await settle()).toBe("granted");
      expect(await settle()).toBe("replayed");
      expect(await run(tierService.tierOf(BOOTSTRAP_WEDDING_ID))).toBe("crimson");
      const [wedding] = await db
        .select({ source: weddings.tierSource, by: weddings.tierGrantedBy })
        .from(weddings)
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID));
      expect(wedding).toEqual({ source: "purchase", by: "stripe:upg_d1" });
      expect(await db.select({ id: platformSales.purchaseId }).from(platformSales)).toEqual([
        { id: "upg_d1" },
      ]);

      // A later, lower grant changes nothing on D1 either.
      await run(
        tierService.grant(BOOTSTRAP_WEDDING_ID, "gold", {
          source: "comp",
          grantedBy: "script:ops",
        }),
      );
      expect(await run(tierService.tierOf(BOOTSTRAP_WEDDING_ID))).toBe("crimson");
    },
    MF_TIMEOUT_MS,
  );
});
