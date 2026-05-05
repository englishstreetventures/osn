import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { guests } from "@cire/db"
import { claimService, InvalidCredentials } from "./claim"
import { DbService } from "../db"
import { TestDbLayer } from "../db/test-layer"
import { effWith } from "../test-helpers"

const withDb = effWith(TestDbLayer)

const SHARMA = {
  publicId: "SHARMA-IVY-QM42",
  password: "amber-cedar-violin-ridge",
}
const PATEL = {
  publicId: "PATEL-JOY-RK97",
  password: "lemon-violet-thyme-eagle",
}
const WILSON = {
  publicId: "WILSON-OAK-7R2P",
  password: "river-marsh-clover-finch",
}

describe("claimService.lookup", () => {
  it(
    "returns family + members + events for valid credentials (single guest)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup(
          SHARMA.publicId,
          SHARMA.password,
        )
        expect(result.familyName).toBe("Sharma")
        expect(result.publicId).toBe(SHARMA.publicId)
        expect(result.members).toEqual([
          {
            firstName: "Priya",
            lastName: "Sharma",
            eventIds: expect.arrayContaining([
              "mehndi",
              "wedding",
              "reception",
            ]),
          },
        ])
        expect(result.events.map((e) => e.id)).toEqual(
          expect.arrayContaining(["mehndi", "wedding", "reception"]),
        )
      }),
    ),
  )

  it(
    "returns each member's own eventIds — Wilson kid is wedding-only",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup(
          WILSON.publicId,
          WILSON.password,
        )
        expect(result.familyName).toBe("Wilson")
        const byName = new Map(result.members.map((m) => [m.firstName, m]))
        expect(byName.get("James")?.eventIds.sort()).toEqual([
          "reception",
          "wedding",
        ])
        expect(byName.get("Emma")?.eventIds.sort()).toEqual([
          "reception",
          "wedding",
        ])
        expect(byName.get("Sophie")?.eventIds).toEqual(["wedding"])
        // Top-level events is the union across the family.
        expect(result.events.map((e) => e.id).sort()).toEqual([
          "reception",
          "wedding",
        ])
      }),
    ),
  )

  it(
    "returns only invited events for the Patels (wedding + reception)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup(
          PATEL.publicId,
          PATEL.password,
        )
        expect(result.events.map((e) => e.id).sort()).toEqual([
          "reception",
          "wedding",
        ])
      }),
    ),
  )

  it(
    "fails with InvalidCredentials for an unknown publicId",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          claimService.lookup("FAKE-XYZ-9999", "anything-here-ok-now"),
        )
        expect(error._tag).toBe("InvalidCredentials")
        expect(error).toBeInstanceOf(InvalidCredentials)
      }),
    ),
  )

  it(
    "fails with InvalidCredentials when publicId matches but password is wrong",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          claimService.lookup(SHARMA.publicId, "wrong-words-ok-fine"),
        )
        expect(error._tag).toBe("InvalidCredentials")
      }),
    ),
  )
})

describe("claimService.getAllGuests", () => {
  it(
    "returns one row per guest across all families (6 total)",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests()
        expect(rows).toHaveLength(6)
      }),
    ),
  )

  it(
    "each row carries the family publicId so the organiser can share it",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests()
        for (const row of rows) {
          expect(row.publicId).toMatch(/^[A-Z]+-[A-Z]+-[A-Z0-9]+$/)
        }
      }),
    ),
  )

  it(
    "each guest has at least one event",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests()
        expect(rows.every((r) => r.events.length > 0)).toBe(true)
      }),
    ),
  )

  it(
    "skips guest rows whose family is missing from the families table",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService
        const now = new Date()
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
          .run()

        const rows = yield* claimService.getAllGuests()
        expect(rows).toHaveLength(6)
        expect(rows.find((r) => r.firstName === "Orphan")).toBeUndefined()
      }),
    ),
  )
})
