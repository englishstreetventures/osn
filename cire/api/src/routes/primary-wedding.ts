import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { weddingsService } from "../services/weddings";

/**
 * Public `GET /api/primary-wedding` — resolves the deployment's primary (default)
 * wedding slug for the guest site's bare-domain (`/`) route, so it can redirect
 * to `/<slug>` with NO build-time slug variable. No auth (the slug is already
 * public — it's the invite URL) and no rate limiter beyond the platform edge: a
 * single cheap, indexed read.
 *
 *  - exactly one / several weddings → 200 `{ slug }` (most-recently-created)
 *  - no wedding configured          → 404 `{ error: "Not found" }`
 *
 * The 404 (rather than `{ slug: null }`) lets the `/` route distinguish "no
 * invitation configured" (neutral state) from a transient API error, without a
 * magic sentinel in the body.
 */
export const createPrimaryWeddingRoutes = (db: Db) =>
  new Elysia().get("/api/primary-wedding", ({ set }) => {
    // The primary slug can change when a new wedding is created, so never serve
    // it stale to the bare-domain redirect.
    set.headers["cache-control"] = "no-store";
    return runCire(
      weddingsService.primaryWeddingSlug().pipe(
        Effect.provideService(DbService, db),
        Effect.map((slug) => {
          if (!slug) {
            set.status = 404;
            return { error: "Not found" };
          }
          return { slug };
        }),
        Effect.catchAllDefect(() =>
          Effect.sync(() => {
            set.status = 500;
            return { error: "Internal error" };
          }),
        ),
      ),
    );
  });
