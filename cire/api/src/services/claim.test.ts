import { describe, it, expect } from "bun:test";

import { guests } from "@cire/db";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

import eventsData from "../data/events.json";
import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { claimService, InvalidCredentials } from "./claim";

const withDb = effWith(TestDbLayer);

const CATHOLIC_ID = eventsData.catholic.id;
const KITCHEN_TEA_ID = eventsData["kitchen-tea"].id;
const MEHENDI_ID = eventsData.mehendi.id;
const HINDU_ID = eventsData.hindu.id;
const RECEPTION_ID = eventsData.reception.id;

describe("claimService.lookup", () => {
  it(
    "returns family + members + events for valid publicId (single guest)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("SHARMA-IVY-QM42");
        expect(result.familyName).toBe("Sharma");
        expect(result.publicId).toBe("SHARMA-IVY-QM42");
        expect(result.members).toHaveLength(1);
        const priya = result.members[0]!;
        expect(priya.firstName).toBe("Priya");
        expect(priya.lastName).toBe("Sharma");
        expect(typeof priya.guestId).toBe("string");
        expect(priya.guestId.length).toBeGreaterThan(0);
        expect([...priya.eventIds].sort()).toEqual([CATHOLIC_ID, HINDU_ID, RECEPTION_ID].sort());
        expect(result.events.map((e) => e.id).sort()).toEqual(
          [CATHOLIC_ID, HINDU_ID, RECEPTION_ID].sort(),
        );
        expect(result.rsvps).toEqual([]);
      }),
    ),
  );

  it(
    "exposes guestId on every member",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("WILSON-OAK-7R2P");
        for (const m of result.members) {
          expect(typeof m.guestId).toBe("string");
          expect(m.guestId.length).toBeGreaterThan(0);
        }
        // All guestIds within a family are unique
        const ids = new Set(result.members.map((m) => m.guestId));
        expect(ids.size).toBe(result.members.length);
      }),
    ),
  );

  it(
    "surfaces extended event metadata (startAt, endAt, timezone, address, palette, urls)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("SHARMA-IVY-QM42");
        const catholic = result.events.find((e) => e.id === CATHOLIC_ID)!;
        expect(catholic.startAt).toBe(eventsData.catholic.startAt);
        expect(catholic.endAt).toBe(eventsData.catholic.endAt);
        expect(catholic.timezone).toBe("Australia/Sydney");
        expect(catholic.address).toBe(eventsData.catholic.address);
        expect(catholic.dressCodeDescription).toBe(eventsData.catholic.dressCodeDescription);
        expect(catholic.dressCodePalette).toEqual(eventsData.catholic.dressCodePalette);
        expect(catholic.pinterestUrl).toBe(eventsData.catholic.pinterestUrl);
        expect(catholic.mapsUrl).toBe(eventsData.catholic.mapsUrl);
        expect(catholic.sortOrder).toBe(0);
      }),
    ),
  );

  it(
    "orders events by sortOrder",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("SHARMA-IVY-QM42");
        const orders = result.events.map((e) => e.sortOrder);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
      }),
    ),
  );

  it(
    "returns each member's own eventIds — Wilson kid is hindu-only",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("WILSON-OAK-7R2P");
        expect(result.familyName).toBe("Wilson");
        const byName = new Map(result.members.map((m) => [m.firstName, m]));
        expect([...(byName.get("James")?.eventIds ?? [])].sort()).toEqual(
          [RECEPTION_ID, HINDU_ID].sort(),
        );
        expect([...(byName.get("Emma")?.eventIds ?? [])].sort()).toEqual(
          [RECEPTION_ID, HINDU_ID].sort(),
        );
        expect(byName.get("Sophie")?.eventIds).toEqual([HINDU_ID]);
        expect(result.events.map((e) => e.id).sort()).toEqual([RECEPTION_ID, HINDU_ID].sort());
      }),
    ),
  );

  it(
    "returns all five events for the Patels (default demo code invites everyone)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("PATEL-JOY-RK97");
        expect(result.events.map((e) => e.id).sort()).toEqual(
          [CATHOLIC_ID, KITCHEN_TEA_ID, MEHENDI_ID, HINDU_ID, RECEPTION_ID].sort(),
        );
      }),
    ),
  );

  it(
    "fails with InvalidCredentials for an unknown publicId",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(claimService.lookup("FAKE-XYZ-9999"));
        expect(error._tag).toBe("InvalidCredentials");
        expect(error).toBeInstanceOf(InvalidCredentials);
      }),
    ),
  );
});

describe("claimService.getAllGuests", () => {
  it(
    "returns one row per guest across all families (6 total)",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests();
        expect(rows).toHaveLength(6);
      }),
    ),
  );

  it(
    "each row carries the family publicId so the organiser can share it",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests();
        for (const row of rows) {
          expect(row.publicId).toMatch(/^[A-Z]+-[A-Z]+-[A-Z0-9]+$/);
        }
      }),
    ),
  );

  it(
    "each row exposes its guestId",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests();
        for (const row of rows) {
          expect(typeof row.guestId).toBe("string");
          expect(row.guestId.length).toBeGreaterThan(0);
        }
      }),
    ),
  );

  it(
    "each guest has at least one event",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests();
        expect(rows.every((r) => r.events.length > 0)).toBe(true);
      }),
    ),
  );

  it(
    "skips guest rows whose family is missing from the families table",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // Plant a legacy orphan row. FK enforcement (now on, matching D1)
        // forbids creating one normally, so toggle it off for this insert —
        // the service must still skip such rows defensively.
        db.run(sql`PRAGMA foreign_keys = OFF`);
        db.insert(guests)
          .values({
            id: crypto.randomUUID(),
            familyId: "non-existent-family-id",
            firstName: "Orphan",
            lastName: "Guest",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.run(sql`PRAGMA foreign_keys = ON`);

        const rows = yield* claimService.getAllGuests();
        expect(rows).toHaveLength(6);
        expect(rows.find((r) => r.firstName === "Orphan")).toBeUndefined();
      }),
    ),
  );
});
