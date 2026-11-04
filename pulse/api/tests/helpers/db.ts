import { Database } from "bun:sqlite";

import { events, pulseCloseFriends, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { applySchema } from "@pulse/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";

export function createTestLayer() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  return Layer.succeed(Db, { db });
}

/** One statement drizzle sent to bun:sqlite: its SQL text and bound parameters. */
export interface Captured {
  sql: string;
  params: readonly unknown[];
}

/**
 * {@link createTestLayer}, plus drizzle's `logger` recording every statement
 * the driver is about to run, in order. For tests that check the SQL a
 * service emits or how many statements one call costs.
 *
 * `beforeStatement` runs as each statement is logged, which drizzle does just
 * before it executes the statement: a write it makes through `sqlite` lands
 * between the service's previous statement and this one, the way a concurrent
 * request's write would.
 */
export function createCapturingTestLayer(
  beforeStatement?: (sql: string, sqlite: Database) => void,
): { layer: Layer.Layer<Db>; captured: Captured[] } {
  const captured: Captured[] = [];
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({
    client: sqlite,
    logger: {
      logQuery: (sql, params) => {
        captured.push({ sql, params });
        beforeStatement?.(sql, sqlite);
      },
    },
  });
  return { layer: Layer.succeed(Db, { db }), captured };
}

/** The leading keyword of each captured statement, lower case: `select`, `update`, … */
export const statementKinds = (captured: readonly Captured[]): string[] =>
  captured.map((c) => c.sql.trimStart().split(/\s/, 1)[0]!.toLowerCase());

/**
 * Insert an event directly into the DB, bypassing service-layer validation.
 * Used by tests that need events with past startTime (e.g. transition tests).
 */
export interface SeedEventInput {
  title: string;
  startTime: string | Date;
  endTime?: string | Date;
  status?: "upcoming" | "ongoing" | "maybe_finished" | "finished" | "cancelled";
  category?: string;
  createdByProfileId?: string;
  createdByName?: string | null;
  createdByAvatar?: string | null;
  visibility?: "public" | "private";
  guestListVisibility?: "public" | "connections" | "private";
  joinPolicy?: "open" | "guest_list";
  allowInterested?: boolean;
  commsChannels?: ("sms" | "email")[];
  chatId?: string;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Insert a Pulse close-friends row directly, bypassing the eligibility
 * check in `addCloseFriend`. Useful for setting up test fixtures without
 * also having to mock the graph bridge.
 */
export const seedCloseFriend = (
  profileId: string,
  friendId: string,
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .insert(pulseCloseFriends)
        .values({
          id: "pcf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          profileId,
          friendId,
          createdAt: new Date(),
        })
        .onConflictDoNothing(),
    );
  });

export const seedEvent = (input: SeedEventInput): Effect.Effect<Event, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "evt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    const row: Event = {
      id,
      title: input.title,
      description: null,
      location: null,
      venue: null,
      venueId: null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      category: input.category ?? null,
      startTime: new Date(input.startTime),
      endTime: input.endTime ? new Date(input.endTime) : null,
      status: input.status ?? "upcoming",
      imageUrl: null,
      priceAmount: input.priceAmount ?? null,
      priceCurrency: input.priceCurrency ?? null,
      visibility: input.visibility ?? "public",
      guestListVisibility: input.guestListVisibility ?? "public",
      joinPolicy: input.joinPolicy ?? "open",
      allowInterested: input.allowInterested ?? true,
      commsChannels: JSON.stringify(input.commsChannels ?? ["email"]),
      chatId: input.chatId ?? null,
      seriesId: null,
      instanceOverride: false,
      createdByProfileId: input.createdByProfileId ?? "usr_alice",
      createdByName: input.createdByName ?? "Alice",
      createdByAvatar: input.createdByAvatar ?? null,
      cancelledAt: null,
      hardDeleteAt: null,
      cancellationReason: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* Effect.promise(() => db.insert(events).values(row));
    return row;
  });
