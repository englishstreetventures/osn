import { Hono } from "hono"
import { Effect, Schema } from "effect"
import { claimService, InvalidCode } from "../services/claim"
import { ClaimBody } from "../schemas/claim"
import { DbService } from "../db"
import type { Db } from "../db"

type AppVariables = { db: Db }

export const claimRoute = new Hono<{ Variables: AppVariables }>()

claimRoute.post("/", async (c) => {
  const raw = await Effect.runPromise(
    Effect.tryPromise({ try: () => c.req.json(), catch: () => null }),
  )

  return Effect.runPromise(
    Effect.gen(function* () {
      const { code } = yield* Schema.decodeUnknown(ClaimBody)(raw)
      const result = yield* claimService.lookup(code.trim().toUpperCase())
      return c.json(result)
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("InvalidCode", () =>
        Effect.succeed(c.json({ error: "Invalid code" }, 401)),
      ),
    ),
  )
})
