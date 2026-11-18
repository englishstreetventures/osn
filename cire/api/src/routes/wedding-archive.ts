import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { EffectDbService, type EffectD1Db } from "../db/effect-handle";
import { metricWeddingArchiveDownload } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { weddingArchiveService } from "../services/wedding-archive";
import type { ArchiveSources } from "../services/wedding-archive";

export interface WeddingArchiveRouteOptions extends ArchiveSources {
  /** The archive's own per-user limit, answered before the shared export one. */
  readonly archiveLimiter: RateLimiterBackend;
  /** The CSV downloads' shared per-user limit, which an archive spends too. */
  readonly exportLimiter: RateLimiterBackend;
  readonly effectDb: EffectD1Db | undefined;
}

/**
 * `POST /api/organiser/weddings/:weddingId/archive` — the whole wedding as one
 * ZIP, for an owner (`services/wedding-archive.ts` says what it holds and the
 * limits it keeps).
 *
 * Gates in order: `osnAuth`, `weddingOwner()` (the multi-owner design: every
 * export is an owner's, and a soft-deleted wedding answers 404 here as
 * everywhere but its restore), the archive's own per-user limit, then the
 * shared export one, so an archive it refuses spends nothing else. No tier
 * gate: the archive is how an owner takes the wedding's data away, at any
 * tier.
 *
 * A POST, mounted after the origin guard, though it changes nothing: as a GET,
 * any same-site page's `<img>` could start the largest read cire makes on an
 * owner's cookie and spend their allowance. No body; the sentinel parse hook
 * keeps Elysia from reading one.
 *
 * Every database read runs before the response starts, so a failed one is a
 * plain 500. The answer is a `Response` around the archive's stream, which
 * Elysia passes on whole; `private, no-store`, since it holds every guest's
 * data. The portal names the saved file itself: the API exposes no
 * `content-disposition` across origins.
 */
export const createWeddingArchiveRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  options: WeddingArchiveRouteOptions,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(options.archiveLimiter))
        .use(rateLimitMiddlewareByUser(options.exportLimiter))
        .post(
          "/archive",
          async ({ weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const effectDb = options.effectDb;
            const plan = await runCire(
              (effectDb === undefined
                ? Effect.die(new Error("wedding archive: no EffectDbService was provided"))
                : weddingArchiveService
                    .read(weddingId)
                    .pipe(
                      Effect.provideService(DbService, db),
                      Effect.provideService(EffectDbService, effectDb),
                    )
              ).pipe(
                Effect.catchDefect(() =>
                  Effect.gen(function* () {
                    metricWeddingArchiveDownload("error");
                    yield* Effect.logError("wedding archive read failed", { weddingId });
                    return null;
                  }),
                ),
              ),
            );
            if (plan === null) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const stream = weddingArchiveService.stream(plan, {
              assets: options.assets,
              sheets: options.sheets,
            });
            return new Response(stream, {
              status: 200,
              headers: {
                "content-type": "application/zip",
                "content-disposition": `attachment; filename="cire-wedding-${plan.wedding.slug}.zip"`,
                "cache-control": "private, no-store",
              },
            });
          },
          { parse: () => ({}) },
        ),
    );
