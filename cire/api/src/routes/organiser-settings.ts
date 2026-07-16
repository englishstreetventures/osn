import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { UpdateSettingsBody } from "../schemas/settings";
import { weddingSettingsService } from "../services/wedding-settings";

// Sentinel parse hook — same idiom as the other organiser POST/PUT routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

/**
 * Wedding-profile Settings routes (platform Phase 0), mounted under
 * /api/organiser/weddings/:weddingId. Siblings by authorisation level,
 * mirroring the organiser-weddings factory:
 *  - GET /settings — weddingMember() (any role incl. viewer; read-only).
 *  - PUT /settings — weddingOwner() (wedding identity + money are owner-only
 *    in the roles matrix — see platform-plan §3.5).
 *
 * There is no separate event "location config" here: an event's place is its
 * free-text `address` (the sole location source the guest map renders). The
 * stored coordinates + pricing region that used to live on `events` (and the
 * geocode endpoint that fed them) were removed by migration 0036 — they only
 * ever served unbuilt Phase 3 planning features.
 */
export const createOrganiserSettingsRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) => {
  return new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/settings", ({ weddingId, set }) => {
        if (!weddingId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        return runCire(
          weddingSettingsService.get(weddingId).pipe(
            Effect.provideService(DbService, db),
            Effect.map((wedding) => ({ wedding })),
            Effect.catchTag("WeddingNotFound", () =>
              Effect.sync(() => {
                set.status = 404;
                return { error: "wedding_not_found" };
              }),
            ),
            Effect.catchAllDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
          ),
        );
      }),
    )
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingOwner(db)).put(
        "/settings",
        async ({ weddingId, request, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const raw: unknown = await request.json().catch(() => null);
          return runCire(
            Effect.gen(function* () {
              const patch = yield* Schema.decodeUnknown(UpdateSettingsBody)(raw);
              const wedding = yield* weddingSettingsService.update(weddingId, patch);
              return { wedding };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTags({
                ParseError: () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                WeddingNotFound: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "wedding_not_found" };
                  }),
                SettingsWriteError: () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not save settings" };
                  }),
              }),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        },
        manualParse,
      ),
    );
};
