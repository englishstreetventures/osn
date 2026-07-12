import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { derivePricingRegion } from "../lib/pricing-regions";
import { metricGeocodeRequest } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { EventLocationBody, GeocodeBody, UpdateSettingsBody } from "../schemas/settings";
import { eventLocationService } from "../services/event-location";
import type { Geocoder } from "../services/geocode";
import { weddingSettingsService } from "../services/wedding-settings";

// Sentinel parse hook — same idiom as the other organiser POST/PUT routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

export interface SettingsRouteOptions {
  /** Key-optional server-side geocoder. `null`/omitted ⇒ the geocode endpoint
   *  answers `unavailable` and the location forms fall back to manual lat/lng. */
  geocoder?: Geocoder | null;
  /** Per-IP limiter for the geocode endpoint — the upstream call is billed per
   *  request, so an authenticated organiser must not be an unbounded amplifier. */
  geocodeLimiter: RateLimiterBackend;
}

/**
 * Wedding-profile Settings + per-event location routes (platform Phase 0,
 * PR 1), mounted under /api/organiser/weddings/:weddingId. Siblings by
 * authorisation level, mirroring the organiser-weddings factory:
 *  - GET /settings — weddingMember() (owner OR co-host; read-only).
 *  - PUT /settings — weddingOwner() (wedding identity + money are owner-only
 *    in the roles matrix — see platform-plan §3.5).
 *  - PUT /events/:eventId/location — weddingMember(): location is SCHEDULE
 *    data (event-scoped — a wedding can span countries), and members already
 *    write the schedule via the spreadsheet import, so the same level applies.
 *  - POST /settings/geocode — weddingMember() + per-IP limiter (it serves the
 *    member-editable event locations; billed upstream call).
 */
export const createOrganiserSettingsRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  options: SettingsRouteOptions,
) => {
  const geocoder = options.geocoder ?? null;

  return new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .get("/settings", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            weddingSettingsService.get(weddingId).pipe(
              Effect.provideService(DbService, db),
              // `geocodingAvailable` tells the location forms whether "Look
              // up" exists or the manual lat/lng fallback should render.
              Effect.map((wedding) => ({ wedding, geocodingAvailable: geocoder !== null })),
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
        })
        // Set/clear one event's planning location (point + pricing region).
        // Member-level: schedule data, same as the import that writes events.
        .put(
          "/events/:eventId/location",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(EventLocationBody)(raw);
                const location = yield* eventLocationService.update(
                  weddingId,
                  params.eventId,
                  body,
                );
                return { event: location };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  ParseError: () =>
                    Effect.sync(() => {
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  EventNotInWedding: () =>
                    Effect.sync(() => {
                      set.status = 404;
                      return { error: "event_not_found" };
                    }),
                  EventLocationWriteError: () =>
                    Effect.sync(() => {
                      set.status = 500;
                      return { error: "Could not save the event location" };
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
    )
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(rateLimitMiddleware(options.geocodeLimiter))
        .post(
          "/settings/geocode",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(GeocodeBody)(raw);

                // KEY-OPTIONAL: no geocoder ⇒ a 200 "unavailable" (not an
                // error) — the form falls back to manual lat/lng entry.
                if (!geocoder) {
                  yield* Effect.sync(() => metricGeocodeRequest("disabled"));
                  return { status: "unavailable" as const };
                }

                const outcome = yield* Effect.promise(() => geocoder.geocode(body.query));
                yield* Effect.sync(() => metricGeocodeRequest(outcome.status));

                if (outcome.status !== "ok") {
                  if (outcome.status === "unavailable") {
                    // Fail-soft by contract, but an operator should still see
                    // it: with a key set, this means the upstream is rejecting
                    // us (quota, bad key, outage). No query text in the log.
                    yield* Effect.logWarning("geocode upstream unavailable", { weddingId });
                  }
                  return { status: outcome.status };
                }

                // The region ships WITH the point so the form echoes both into
                // the save — the client never derives it.
                return {
                  status: "ok" as const,
                  point: outcome.point,
                  pricingRegion: derivePricingRegion(
                    outcome.point.countryCode,
                    outcome.point.adminArea,
                  ),
                };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
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
          },
          manualParse,
        ),
    );
};
