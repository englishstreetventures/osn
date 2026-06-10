import { Effect } from "effect";
import { Hono } from "hono";

import { DbService } from "../db";
import type { Db } from "../db";
import { claimService } from "../services/claim";
import { weddingsService } from "../services/weddings";

type AppVariables = { db: Db; osnProfileId?: string };

export const organiserRoute = new Hono<{ Variables: AppVariables }>();

// Legacy flat aliases (no :weddingId in the path) — kept until Phase 6
// deletes them in favour of /api/organiser/weddings/:weddingId/*. The
// wedding is derived from the caller: exactly one owned wedding scopes
// the query; zero is a 404; more than one is ambiguous and the caller
// must use the explicit wedding-scoped routes.
function withOwnedWedding(
  c: { var: { db: Db; osnProfileId?: string } },
  run: (weddingId: string) => Effect.Effect<Response, never, DbService>,
): Promise<Response> {
  const osnProfileId = c.var.osnProfileId;
  const json = (body: unknown, status: 200 | 400 | 401 | 404 | 500) =>
    Response.json(body, { status });
  if (!osnProfileId) return Promise.resolve(json({ error: "unauthorised" }, 401));

  return Effect.runPromise(
    weddingsService.listForOwner(osnProfileId).pipe(
      Effect.flatMap((owned) => {
        if (owned.length === 0) {
          return Effect.succeed(json({ error: "no_weddings" }, 404));
        }
        if (owned.length > 1) {
          return Effect.succeed(
            json(
              {
                error: "multiple_weddings",
                hint: "use /api/organiser/weddings/:weddingId/...",
              },
              400,
            ),
          );
        }
        return run(owned[0].id);
      }),
      Effect.provideService(DbService, c.var.db),
      Effect.catchAllDefect(() => Effect.succeed(json({ error: "Internal error" }, 500))),
    ),
  );
}

organiserRoute.get("/guests", (c) =>
  withOwnedWedding(c, (weddingId) =>
    claimService.getAllGuests(weddingId).pipe(Effect.map((guestList) => c.json(guestList))),
  ),
);

organiserRoute.get("/events", (c) =>
  withOwnedWedding(c, (weddingId) =>
    claimService.listEvents(weddingId).pipe(Effect.map((eventList) => c.json(eventList))),
  ),
);
