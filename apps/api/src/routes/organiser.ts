import { Hono } from "hono"
import { Effect } from "effect"
import { claimService } from "../services/claim"
import { DbService } from "../db"
import type { Db } from "../db"

type AppVariables = { db: Db }

export const organiserRoute = new Hono<{ Variables: AppVariables }>()

organiserRoute.get("/guests", (c) => {
  return Effect.runPromise(
    claimService
      .getAllGuests()
      .pipe(
        Effect.provideService(DbService, c.var.db),
        Effect.map((guestList) => c.json(guestList)),
        Effect.catchAllDefect(() =>
          Effect.succeed(c.json({ error: "Internal error" }, 500)),
        ),
      ),
  )
})
