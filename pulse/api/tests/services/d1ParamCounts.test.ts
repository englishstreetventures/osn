/**
 * osn-tracker #590, #591, #592, #594, #595 + events.ts:296 — regression
 * guard for the "bound one SQL parameter per array element / per column
 * per row" defect class. D1 caps a query at 100 bound parameters
 * (developers.cloudflare.com/d1/platform/limits/); bun:sqlite enforces no
 * such cap, so these tests can't reproduce the production failure by
 * running past 100 params and watching it throw. What they DO prove,
 * cheaply and on every test run: the real service functions — not a
 * reconstruction of their queries — emit the SQL this fix promises,
 * exercised well past the OLD per-site cliff each site used to break at.
 *
 * The capture mechanism is drizzle's own `logger` hook, which fires with
 * the exact SQL text and bound-parameter array the driver is about to
 * run — the same thing `.toSQL()` would give a query-builder chain, but
 * reachable here because these sites build their statements inside a
 * service function rather than handing back a chain a test can call
 * `.toSQL()` on directly. If a future edit reverts any of these sites to
 * a plain `inArray(col, ids)` or `.values(rows)`, the captured parameter
 * count jumps from O(1) to O(n) and the relevant assertion below fails.
 *
 * Six sites, in the order the brief lists them:
 *   1. series.ts        materializeInstances  — INSERT, 31 cols/row
 *   2. accountErasure.ts purgeAccount         — 4 hostedEventIds DELETEs
 *   3. closeFriends.ts  getCloseFriendsOfBatch
 *      pulseUsers.ts    getAttendanceVisibilityBatch
 *   4. rsvps.ts         inviteGuests          — SELECT + INSERT, 6 cols/row
 *   5. discovery.ts     discoverEvents(friendsOnly) — connectionIds bound twice
 *   6. events.ts        applyTransitions (via listTodayEvents)
 */

import { Database } from "bun:sqlite";

import { events, eventSeries, type EventSeries } from "@pulse/db/schema";
import * as schema from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { applySchema } from "@pulse/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { purgeAccount } from "../../src/services/accountErasure";
import { getCloseFriendsOfBatch } from "../../src/services/closeFriends";
import { discoverEvents, type DiscoveryLookups } from "../../src/services/discovery";
import { applyTransitions } from "../../src/services/events";
import { getAttendanceVisibilityBatch } from "../../src/services/pulseUsers";
import { inviteGuests } from "../../src/services/rsvps";
import { materializeInstances, parseRRule } from "../../src/services/series";
import { seedEvent } from "../helpers/db";

interface Captured {
  sql: string;
  params: readonly unknown[];
}

/**
 * Same shape as `../helpers/db`'s `createTestLayer`, plus a `logger` that
 * records every statement drizzle actually sends to bun:sqlite. Kept local
 * to this file rather than added to the shared helper — no other suite
 * needs to inspect emitted SQL, and threading a capture array through the
 * shared helper's signature would be dead weight everywhere else.
 */
function createCapturingTestLayer(): { layer: Layer.Layer<Db>; captured: Captured[] } {
  const captured: Captured[] = [];
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle(sqlite, {
    schema,
    logger: { logQuery: (sql, params) => captured.push({ sql, params }) },
  });
  return { layer: Layer.succeed(Db, { db }), captured };
}

/** The one statement in `captured` whose SQL contains every one of `needles`. */
function findStatement(captured: Captured[], ...needles: string[]): Captured {
  // Case-insensitive: drizzle's own builder emits lowercase keywords, while a
  // statement assembled through `sql` carries whatever case it was written in
  // — `insertManyViaJsonEach` writes `INSERT INTO`. Matching case-sensitively
  // silently found nothing and read as "the fix did not apply".
  const matches = captured.filter((c) =>
    needles.every((n) => c.sql.toLowerCase().includes(n.toLowerCase())),
  );
  expect(
    matches,
    `expected exactly one captured statement matching ${needles.join(" + ")}`,
  ).toHaveLength(1);
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// 1. series.ts materializeInstances — osn-tracker#594
// ---------------------------------------------------------------------------

describe("series.ts materializeInstances (osn-tracker#594)", () => {
  it("inserts 200 instances (31 cols/row — 6200 params the old way) with 1 bound param", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const now = new Date();
    const dtstart = new Date(now.getTime() + 7 * 86_400_000);
    const series: EventSeries = {
      id: "srs_test",
      title: "Weekly Yoga",
      description: null,
      location: null,
      venue: null,
      latitude: null,
      longitude: null,
      category: null,
      imageUrl: null,
      durationMinutes: null,
      visibility: "public",
      guestListVisibility: "public",
      joinPolicy: "open",
      allowInterested: true,
      commsChannels: '["email"]',
      rrule: "FREQ=WEEKLY;COUNT=200",
      chatId: null,
      dtstart,
      timezone: "UTC",
      until: null,
      materializedThrough: dtstart,
      status: "active",
      createdByProfileId: "usr_alice",
      createdByName: "Alice",
      createdByAvatar: null,
      createdAt: now,
      updatedAt: now,
    };
    // `events.series_id` is a foreign key onto `event_series`, so the series
    // row has to exist before its instances can be inserted — the in-memory
    // object above is the service's input, not a database row.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() => db.insert(eventSeries).values(series));
      }).pipe(Effect.provide(layer)),
    );

    const parsed = await Effect.runPromise(parseRRule("FREQ=WEEKLY;COUNT=200", dtstart));

    const instances = await Effect.runPromise(
      materializeInstances(series, parsed, "create").pipe(Effect.provide(layer)),
    );
    expect(instances).toHaveLength(200);

    const insertStmt = findStatement(captured, 'insert into "events"', "json_each");
    expect(insertStmt.params).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. accountErasure.ts purgeAccount — osn-tracker#595 (GDPR)
// ---------------------------------------------------------------------------

describe("accountErasure.ts purgeAccount (osn-tracker#595)", () => {
  it("purges an account with 150 hosted events (past the old 100-id cliff) via 1-param deletes", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const HOST = "usr_host";

    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 150 }, (_, i) => i),
        (i) =>
          seedEvent({
            title: `Event ${i}`,
            startTime: new Date(Date.now() + 86_400_000).toISOString(),
            createdByProfileId: HOST,
          }),
        { discard: true },
      ).pipe(Effect.provide(layer)),
    );

    const result = await Effect.runPromise(
      purgeAccount("acc_host", [HOST]).pipe(Effect.provide(layer)),
    );
    expect(result).toMatchObject({ purged: 1, alreadyProcessed: false });

    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Db;
        return yield* Effect.promise(() => db.select().from(events));
      }).pipe(Effect.provide(layer)),
    );
    expect(remaining).toHaveLength(0);

    for (const needle of ['"event_rsvps"', '"event_comms"', '"event_lineup"', '"events"']) {
      const stmt = findStatement(captured, "delete from " + needle, "json_each");
      expect(stmt.params, `${needle} delete should bind 1 param`).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. closeFriends.ts getCloseFriendsOfBatch + pulseUsers.ts
//    getAttendanceVisibilityBatch — osn-tracker#591
// ---------------------------------------------------------------------------

describe("closeFriends.ts getCloseFriendsOfBatch (osn-tracker#591)", () => {
  it("looks up 150 attendees (past the old 100-id cliff, and past the old 1000-id truncation risk) with 1 bound param", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const attendeeIds = Array.from({ length: 150 }, (_, i) => `usr_${i}`);

    const result = await Effect.runPromise(
      getCloseFriendsOfBatch("usr_viewer", attendeeIds).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual(new Set());

    const stmt = findStatement(captured, 'from "pulse_close_friends"', "json_each");
    expect(stmt.params).toHaveLength(2); // friendId = ? , profileId IN json_each(?)
  });
});

describe("pulseUsers.ts getAttendanceVisibilityBatch (osn-tracker#591)", () => {
  it("looks up 150 attendees with 1 bound param instead of 1-per-id", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const attendeeIds = Array.from({ length: 150 }, (_, i) => `usr_${i}`);

    const result = await Effect.runPromise(
      getAttendanceVisibilityBatch(attendeeIds).pipe(Effect.provide(layer)),
    );
    expect(result.size).toBe(150); // every id defaults even with no rows

    const stmt = findStatement(captured, 'from "pulse_users"', "json_each");
    expect(stmt.params).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. rsvps.ts inviteGuests — osn-tracker#590 (both the SELECT and the INSERT)
// ---------------------------------------------------------------------------

describe("rsvps.ts inviteGuests (osn-tracker#590)", () => {
  it("invites 150 guests (past the old ~17-row insert cliff) with 1 bound param each on the SELECT and the INSERT", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const event = await Effect.runPromise(
      seedEvent({
        title: "Big Party",
        startTime: new Date(Date.now() + 86_400_000).toISOString(),
        joinPolicy: "guest_list",
        createdByProfileId: "usr_organiser",
      }).pipe(Effect.provide(layer)),
    );
    const profileIds = Array.from({ length: 150 }, (_, i) => `usr_guest_${i}`);

    const result = await Effect.runPromise(
      inviteGuests(event.id, "usr_organiser", { profileIds }).pipe(Effect.provide(layer)),
    );
    expect(result.invited).toBe(150);

    const selectStmt = findStatement(captured, 'from "event_rsvps"', "json_each", "select");
    expect(selectStmt.params).toHaveLength(2); // event_id = ?, profile_id IN json_each(?)

    const insertStmt = findStatement(captured, 'insert into "event_rsvps"', "json_each");
    expect(insertStmt.params).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. discovery.ts discoverEvents(friendsOnly) — osn-tracker#592
// ---------------------------------------------------------------------------

describe("discovery.ts discoverEvents friendsOnly (osn-tracker#592)", () => {
  it("filters by 150 connections (past the old ~50-connection cliff), the set bound twice at 1 param each", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const connectionIds = Array.from({ length: 150 }, (_, i) => `usr_conn_${i}`);
    const lookups: DiscoveryLookups = {
      getConnectionIds: () => Effect.succeed(new Set(connectionIds)),
    };

    const result = await Effect.runPromise(
      discoverEvents({ friendsOnly: true }, "usr_viewer", lookups).pipe(Effect.provide(layer)),
    );
    expect(result.events).toEqual([]);

    const stmt = findStatement(captured, 'from "events"', "json_each");
    // The connection set appears twice in the friendsPredicate (inArray +
    // the EXISTS subquery) — 2 occurrences, 1 bound param each, never 2×n.
    const jsonEachOccurrences = (stmt.sql.match(/json_each/g) ?? []).length;
    expect(jsonEachOccurrences).toBe(2);
    // The property is invariance, not a magic ceiling: a threshold has to be
    // guessed, and guessing it low is how this assertion first failed at 11
    // against a `toBeLessThan(10)` that proved nothing either way. Run the
    // same query with ten times the connections and require the bound
    // parameter count to be identical — that is what "does not bind per
    // element" actually means, and it fails the moment anyone reverts a
    // json_each back to a list.
    const wide = createCapturingTestLayer();
    await Effect.runPromise(
      discoverEvents({ friendsOnly: true }, "usr_viewer", {
        getConnectionIds: () =>
          Effect.succeed(new Set(Array.from({ length: 1_500 }, (_, i) => `usr_conn_${i}`))),
      }).pipe(Effect.provide(wide.layer)),
    );
    const wideStmt = findStatement(wide.captured, 'from "events"', "json_each");
    expect(wideStmt.params.length).toBe(stmt.params.length);
    // And it is bounded well under D1's cap of 100 rather than merely equal.
    expect(stmt.params.length).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// 6. events.ts applyTransitions — events.ts:296
// ---------------------------------------------------------------------------

describe("events.ts applyTransitions (events.ts:296)", () => {
  it("transitions 150 events sharing one (upcoming → ongoing) group (past the old 99-event cliff) with 1 bound id-list param", async () => {
    const { layer, captured } = createCapturingTestLayer();
    // Started 1 minute ago, no endTime → deriveStatus returns "ongoing"
    // (well under MAYBE_FINISHED_AFTER_HOURS), so every row transitions
    // upcoming → ongoing in a single group.
    const rows = await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 150 }, (_, i) => i),
        (i) =>
          seedEvent({
            title: `Event ${i}`,
            startTime: new Date(Date.now() - 60_000).toISOString(),
            status: "upcoming",
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(layer)),
    );

    const transitioned = await Effect.runPromise(
      applyTransitions(rows).pipe(Effect.provide(layer)),
    );
    expect(transitioned.every((e) => e.status === "ongoing")).toBe(true);

    const stmt = findStatement(captured, 'update "events"', "json_each");
    // status = ?, updated_at = ?, id IN json_each(?) — 3 total, never
    // ids.length + 2 (which would be 152 for this test's 150 rows).
    expect(stmt.params).toHaveLength(3);
  });
});
