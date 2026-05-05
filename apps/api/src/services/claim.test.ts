import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { guests } from "@cire/db";
import { claimService, InvalidCredentials } from "./claim";
import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import eventsData from "../data/events.json";

const withDb = effWith(TestDbLayer);

const MEHNDI_ID = eventsData.mehndi.id;
const SANGEET_ID = eventsData.sangeet.id;
const WEDDING_ID = eventsData.wedding.id;
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
        expect([...priya.eventIds].sort()).toEqual([MEHNDI_ID, WEDDING_ID, RECEPTION_ID].sort());
        expect(result.events.map((e) => e.id).sort()).toEqual(
          [MEHNDI_ID, WEDDING_ID, RECEPTION_ID].sort(),
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
        const mehndi = result.events.find((e) => e.id === MEHNDI_ID)!;
        expect(mehndi.startAt).toBe(eventsData.mehndi.startAt);
        expect(mehndi.endAt).toBe(eventsData.mehndi.endAt);
        expect(mehndi.timezone).toBe("Australia/Sydney");
        expect(mehndi.address).toBe(eventsData.mehndi.address);
        expect(mehndi.dressCodeDescription).toBe(eventsData.mehndi.dressCodeDescription);
        expect(mehndi.dressCodePalette).toEqual(eventsData.mehndi.dressCodePalette);
        expect(mehndi.pinterestUrl).toBe(eventsData.mehndi.pinterestUrl);
        expect(mehndi.mapsUrl).toBe(eventsData.mehndi.mapsUrl);
        expect(mehndi.sortOrder).toBe(0);
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
    "returns each member's own eventIds — Wilson kid is wedding-only",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("WILSON-OAK-7R2P");
        expect(result.familyName).toBe("Wilson");
        const byName = new Map(result.members.map((m) => [m.firstName, m]));
        expect([...(byName.get("James")?.eventIds ?? [])].sort()).toEqual(
          [RECEPTION_ID, WEDDING_ID].sort(),
        );
        expect([...(byName.get("Emma")?.eventIds ?? [])].sort()).toEqual(
          [RECEPTION_ID, WEDDING_ID].sort(),
        );
        expect(byName.get("Sophie")?.eventIds).toEqual([WEDDING_ID]);
        expect(result.events.map((e) => e.id).sort()).toEqual([RECEPTION_ID, WEDDING_ID].sort());
      }),
    ),
  );

  it(
    "returns only invited events for the Patels (wedding + reception)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("PATEL-JOY-RK97");
        expect(result.events.map((e) => e.id).sort()).toEqual([RECEPTION_ID, WEDDING_ID].sort());
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

        const rows = yield* claimService.getAllGuests();
        expect(rows).toHaveLength(6);
        expect(rows.find((r) => r.firstName === "Orphan")).toBeUndefined();
      }),
    ),
  );

  // Suppress "SANGEET imported but unused" — referenced for future tests once
  // anyone in the seed is invited to it (currently no one is).
  void SANGEET_ID;
});
