import { Database } from "bun:sqlite";

import * as schema from "@pulse/db/schema";
import { events, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { applySchema } from "@pulse/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";

export function createTestLayer() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
  return Layer.succeed(Db, { db });
}

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
      createdAt: now,
      updatedAt: now,
    };
    yield* Effect.promise(() => db.insert(events).values(row));
    return row;
  });
