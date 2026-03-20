import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { claimService, InvalidCode } from "./claim"
import { TestDbLayer } from "../db/test-layer"
import { effWith } from "../test-helpers"

const withDb = effWith(TestDbLayer)

describe("claimService.lookup", () => {
  it(
    "returns guest name and matching events for a valid code",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("PRI-IVY-QM42")
        expect(result.guestName).toBe("Priya Sharma")
        expect(result.events).toHaveLength(3)
        expect(result.events.map((e) => e.id)).toEqual(
          expect.arrayContaining(["mehndi", "wedding", "reception"]),
        )
      }),
    ),
  )

  it(
    "returns only the guest's events — Dev Patel has 2",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("DEV-JOY-RK97")
        expect(result.guestName).toBe("Dev Patel")
        expect(result.events.map((e) => e.id)).toEqual(
          expect.arrayContaining(["wedding", "reception"]),
        )
        expect(result.events.map((e) => e.id)).not.toContain("mehndi")
      }),
    ),
  )

  it(
    "fails with InvalidCode for an unknown code",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(claimService.lookup("FAKE-0000"))
        expect(error._tag).toBe("InvalidCode")
        expect(error).toBeInstanceOf(InvalidCode)
      }),
    ),
  )
})

describe("claimService.getAllGuests", () => {
  it(
    "returns all 4 guests",
    withDb(
      Effect.gen(function* () {
        const guestList = yield* claimService.getAllGuests()
        expect(guestList).toHaveLength(4)
      }),
    ),
  )

  it(
    "all guests have claimed: false initially",
    withDb(
      Effect.gen(function* () {
        const guestList = yield* claimService.getAllGuests()
        expect(guestList.every((g) => g.claimed === false)).toBe(true)
      }),
    ),
  )

  it(
    "each guest has at least one event",
    withDb(
      Effect.gen(function* () {
        const guestList = yield* claimService.getAllGuests()
        expect(guestList.every((g) => g.events.length > 0)).toBe(true)
      }),
    ),
  )
})
