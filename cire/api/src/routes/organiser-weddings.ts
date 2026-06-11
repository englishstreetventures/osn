import { Effect } from "effect";
import { Hono } from "hono";

import { DbService } from "../db";
import type { Db } from "../db";
import { weddingOwner } from "../middleware/wedding-owner";
import { claimService } from "../services/claim";
import { weddingsService } from "../services/weddings";

type AppVariables = { db: Db; osnProfileId?: string; weddingId?: string };

/**
 * Wedding-scoped organiser routes, mounted under /api/organiser. osnAuth()
 * runs upstream (app.ts) so osnProfileId is set on every request here;
 * weddingOwner() additionally gates the per-wedding subtree.
 */
export const organiserWeddingsRoute = new Hono<{ Variables: AppVariables }>();

organiserWeddingsRoute.use("/weddings/:weddingId/*", weddingOwner());

organiserWeddingsRoute.get("/weddings", (c) => {
  const osnProfileId = c.var.osnProfileId;
  if (!osnProfileId) return c.json({ error: "unauthorised" }, 401);
  return Effect.runPromise(
    weddingsService.listForOwner(osnProfileId).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.map((list) => c.json({ weddings: list })),
      Effect.catchAllDefect(() => Effect.succeed(c.json({ error: "Internal error" }, 500))),
    ),
  );
});

organiserWeddingsRoute.get("/weddings/:weddingId/guests", (c) => {
  // weddingOwner() always sets this; the guard keeps a future remount
  // without the middleware from compiling into an unscoped query.
  const weddingId = c.var.weddingId;
  if (!weddingId) return c.json({ error: "Internal error" }, 500);
  return Effect.runPromise(
    claimService.getAllGuests(weddingId).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.map((guestList) => c.json(guestList)),
      Effect.catchAllDefect(() => Effect.succeed(c.json({ error: "Internal error" }, 500))),
    ),
  );
});

organiserWeddingsRoute.get("/weddings/:weddingId/events", (c) => {
  const weddingId = c.var.weddingId;
  if (!weddingId) return c.json({ error: "Internal error" }, 500);
  return Effect.runPromise(
    claimService.listEvents(weddingId).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.map((eventList) => c.json(eventList)),
      Effect.catchAllDefect(() => Effect.succeed(c.json({ error: "Internal error" }, 500))),
    ),
  );
});
