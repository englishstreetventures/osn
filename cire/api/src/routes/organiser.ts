import { Effect } from "effect";
import { Hono } from "hono";

import { DbService } from "../db";
import type { Db } from "../db";
import { claimService } from "../services/claim";

type AppVariables = { db: Db };

export const organiserRoute = new Hono<{ Variables: AppVariables }>();

organiserRoute.get("/guests", (c) => {
  return Effect.runPromise(
    claimService.getAllGuests().pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.map((guestList) => c.json(guestList)),
      Effect.catchAllDefect(() => Effect.succeed(c.json({ error: "Internal error" }, 500))),
    ),
  );
});

organiserRoute.get("/events", (c) => {
  return Effect.runPromise(
    claimService.listEvents().pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.map((eventList) => c.json(eventList)),
      Effect.catchAllDefect(() => Effect.succeed(c.json({ error: "Internal error" }, 500))),
    ),
  );
});
