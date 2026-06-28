import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import {
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  weddings,
  BOOTSTRAP_WEDDING_ID,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Miniflare } from "miniflare";

import type { ImportPlan } from "../schemas/import";
import { claimService } from "../services/claim";
import { applyImport } from "../services/import";
import { rsvpService } from "../services/rsvp";
import { createD1Db, DbService } from "./index";
import type { Db } from "./index";
import { DDL } from "./setup";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// The rest of the suite runs on synchronous bun:sqlite; these exercise the
// ASYNCHRONOUS D1 driver path that production actually uses — the `dbQuery`
// bridge, awaited writes, and the `db.batch([...])` branch of `applyImport`
// (which bun:sqlite cannot reach). This is the only coverage of that path.

// Schema setup and FK-ordered truncation are inherently sequential here.
/* eslint-disable no-await-in-loop */

const PUBLIC_ID = "TESTFAM-AA01";
const FAMILY_ID = "fam1";
const EVENT_A = "evt_a";
const EVENT_B = "evt_b";
const GUEST_1 = "g1";
const GUEST_2 = "g2";

let mf: Miniflare;
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
// is the CI-only flake. Give every Miniflare-backed hook a generous budget so a
// cold boot can never race the default timeout.
const MF_HOOK_TIMEOUT_MS = 30_000;

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
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  // Apply the schema statement-by-statement — D1's `exec` splits on newlines,
  // which breaks multi-line CREATE TABLEs, so prepare/run each full statement.
  for (const stmt of DDL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await d1.prepare(stmt).run();
  }
  db = createD1Db(d1);
}, MF_HOOK_TIMEOUT_MS);

afterAll(async () => {
  // `dispose()` poisons every D1 stub this instance handed out — only call it
  // once the suite is fully done so no in-flight query can resolve against a
  // dead stub. (All hooks/tests above `await` their D1 ops, so nothing is
  // pending here; this stays defensive in case that ever changes.)
  await mf?.dispose();
}, MF_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // FK-safe truncate, then reseed — keeps each test isolated on the shared D1.
  for (const table of [rsvps, guestEvents, guests, families, events, weddings]) {
    await db.delete(table);
  }
  await seed();
}, MF_HOOK_TIMEOUT_MS);

describe("cire/api over real D1 (Miniflare)", () => {
  it("claim.lookup resolves a seeded family across async D1 reads", async () => {
    const res = await run(claimService.lookup(PUBLIC_ID));
    expect(res.familyId).toBe(FAMILY_ID);
    expect(res.publicId).toBe(PUBLIC_ID);
    expect(res.members).toHaveLength(2);
    expect(res.events.map((e) => e.name).toSorted()).toEqual(["Ceremony", "Reception"]);
  });

  it("claim.lookup fails for an unknown code", async () => {
    await expect(run(claimService.lookup("NOPE-0000"))).rejects.toThrow();
  });

  it("submitRsvp upserts over async D1 (insert then in-place update)", async () => {
    await run(
      rsvpService.submitRsvp({
        guestId: GUEST_1,
        eventId: EVENT_A,
        status: "attending",
        dietary: "none",
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
      }),
    );
    rows = await run(rsvpService.getRsvpsForFamily(FAMILY_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "declined", dietary: "veg" });
  });

  it("applyImport commits a write set via the D1 batch path", async () => {
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
      familyRemoves: [],
      guestCreates: [
        {
          id: newGuestId,
          familyId: newFamilyId,
          firstName: "Carol",
          lastName: "New",
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
  });

  it("applyImport batch is atomic — a mid-batch constraint violation persists nothing", async () => {
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
  });
});
