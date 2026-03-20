import { describe, it, expect, beforeAll } from "bun:test"
import { Effect } from "effect"
import { createApp } from "../app"
import { createDb, seedDb } from "../db/setup"
import { eff } from "../test-helpers"

interface ClaimOk {
  guestName: string
  events: unknown[]
}

const db = createDb(":memory:")
seedDb(db)
const app = createApp(db)

const post = (body: unknown) =>
  Effect.promise(() =>
    app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )

describe("POST /api/claim", () => {
  it(
    "returns 400 when code field is missing",
    eff(
      Effect.gen(function* () {
        const res = yield* post({})
        expect(res.status).toBe(400)
        const data = yield* Effect.promise(() => res.json<{ error: string }>())
        expect(data.error).toBe("Missing or invalid fields")
      }),
    ),
  )

  it(
    "returns 400 when code is an empty string",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ code: "" })
        expect(res.status).toBe(400)
      }),
    ),
  )

  it(
    "returns 401 for an unknown claim code",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ code: "FAKE-0000" })
        expect(res.status).toBe(401)
        const data = yield* Effect.promise(() => res.json<{ error: string }>())
        expect(data.error).toBe("Invalid code")
      }),
    ),
  )

  it(
    "returns 200 with guest and events for valid code PRI-IVY-QM42",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ code: "PRI-IVY-QM42" })
        expect(res.status).toBe(200)
        const data = yield* Effect.promise(() => res.json<ClaimOk>())
        expect(data.guestName).toBe("Priya Sharma")
        expect(data.events).toHaveLength(3)
      }),
    ),
  )

  it(
    "uppercases the code before lookup",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ code: "pri-ivy-qm42" })
        expect(res.status).toBe(200)
        const data = yield* Effect.promise(() =>
          res.json<{ guestName: string }>(),
        )
        expect(data.guestName).toBe("Priya Sharma")
      }),
    ),
  )
})
