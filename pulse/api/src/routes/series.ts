import type { EventSeries } from "@pulse/db/schema";
import { DbLive, type Db } from "@pulse/db/service";
import { extractClaims } from "@shared/osn-auth-client/verify";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL } from "../lib/jwks";
import { checkWriteRateLimit, createDefaultWriteRateLimiter } from "../lib/rate-limit";
import { canViewEvent } from "../services/eventAccess";
import {
  cancelSeries,
  createSeries,
  getSeries,
  listInstances,
  updateSeries,
} from "../services/series";
import { eventResponseSchema, serializeEvent } from "./events";

const visibilityEnum = t.Optional(t.Union([t.Literal("public"), t.Literal("private")]));
const guestListVisibilityEnum = t.Optional(
  t.Union([t.Literal("public"), t.Literal("connections"), t.Literal("private")]),
);
const joinPolicyEnum = t.Optional(t.Union([t.Literal("open"), t.Literal("guest_list")]));
const commsChannelsSchema = t.Optional(
  t.Array(t.Union([t.Literal("sms"), t.Literal("email")]), { minItems: 1, maxItems: 2 }),
);

const messageResponse = t.Object({ message: t.String() });
const errorResponse = t.Object({ error: t.String() });

/**
 * Converts a raw `event_series` row (drizzle hydrates `timestamp` columns to
 * `Date`) into its wire shape — same rationale as `serializeEvent` in
 * `routes/events.ts`: the `response:` schema validates the pre-serialisation
 * value, so `t.String({ format: "date-time" })` needs an actual string.
 */
const serializeSeries = (s: EventSeries) => ({
  ...s,
  dtstart: s.dtstart.toISOString(),
  until: s.until ? s.until.toISOString() : null,
  materializedThrough: s.materializedThrough.toISOString(),
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const seriesResponseSchema = t.Object({
  id: t.String(),
  title: t.String(),
  description: t.Nullable(t.String()),
  location: t.Nullable(t.String()),
  venue: t.Nullable(t.String()),
  latitude: t.Nullable(t.Number()),
  longitude: t.Nullable(t.Number()),
  category: t.Nullable(t.String()),
  imageUrl: t.Nullable(t.String()),
  durationMinutes: t.Nullable(t.Number()),
  visibility: t.Union([t.Literal("public"), t.Literal("private")]),
  guestListVisibility: t.Union([
    t.Literal("public"),
    t.Literal("connections"),
    t.Literal("private"),
  ]),
  joinPolicy: t.Union([t.Literal("open"), t.Literal("guest_list")]),
  allowInterested: t.Boolean(),
  commsChannels: t.String(),
  rrule: t.String(),
  dtstart: t.String({ format: "date-time" }),
  until: t.Nullable(t.String({ format: "date-time" })),
  materializedThrough: t.String({ format: "date-time" }),
  timezone: t.String(),
  status: t.Union([t.Literal("active"), t.Literal("ended"), t.Literal("cancelled")]),
  chatId: t.Nullable(t.String()),
  createdByProfileId: t.String(),
  createdByName: t.Nullable(t.String()),
  createdByAvatar: t.Nullable(t.String()),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

const rruleInvalidReasonEnum = t.Union([
  t.Literal("unsupported_freq"),
  t.Literal("too_many_instances"),
  t.Literal("missing_termination"),
  t.Literal("parse_error"),
]);

export const createSeriesRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
  /**
   * Per-USER write limiters keyed on `claims.profileId` (W4). Defaults are
   * in-memory; production wires Redis backends at the composition root.
   */
  writeRateLimiters: {
    seriesCreate?: RateLimiterBackend;
    seriesUpdate?: RateLimiterBackend;
  } = {},
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  const seriesCreateLimiter =
    writeRateLimiters.seriesCreate ?? createDefaultWriteRateLimiter("series_create");
  const seriesUpdateLimiter =
    writeRateLimiters.seriesUpdate ?? createDefaultWriteRateLimiter("series_update");
  return (
    new Elysia({ prefix: "/series" })
      // Same named models as `routes/events.ts`: registering `Event` again with
      // the identical schema dedupes by name in the root document, and keeping
      // the registration local means this plugin resolves its own `$ref`s
      // whether or not the events plugin is mounted alongside it.
      .model({ Event: eventResponseSchema, Series: seriesResponseSchema })
      .post(
        "/",
        async ({ body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          if (
            !(await checkWriteRateLimit(seriesCreateLimiter, "series_create", claims.profileId))
          ) {
            set.status = 429;
            return { error: "Too many requests" } as const;
          }
          const creator = {
            createdByProfileId: claims.profileId,
            createdByName:
              claims.displayName ??
              (claims.handle ? `@${claims.handle}` : null) ??
              (claims.email ? (claims.email.split("@")[0] ?? null) : null),
            createdByAvatar: null,
          };
          const result = await runtime.runPromise(
            createSeries(body, creator).pipe(
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.catchTag("SeriesRRuleInvalid", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: e.message, reason: e.reason } as const;
                }),
              ),
            ),
          );
          if ("error" in result) return result;
          set.status = 201;
          return {
            series: serializeSeries(result.series),
            instances: result.instances.map(serializeEvent),
          };
        },
        {
          parse: "application/json",
          body: t.Object({
            title: t.String({ minLength: 1, maxLength: 200 }),
            description: t.Optional(t.String({ maxLength: 5000 })),
            location: t.Optional(t.String({ maxLength: 500 })),
            venue: t.Optional(t.String({ maxLength: 500 })),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            category: t.Optional(t.String({ maxLength: 100 })),
            imageUrl: t.Optional(t.String()),
            durationMinutes: t.Optional(t.Number({ minimum: 1, maximum: 60 * 24 * 14 })),
            visibility: visibilityEnum,
            guestListVisibility: guestListVisibilityEnum,
            joinPolicy: joinPolicyEnum,
            allowInterested: t.Optional(t.Boolean()),
            commsChannels: commsChannelsSchema,
            rrule: t.String({ minLength: 1, maxLength: 500 }),
            dtstart: t.String({ format: "date-time" }),
            timezone: t.Optional(t.String({ maxLength: 100 })),
          }),
          response: {
            201: t.Object({ series: t.Ref("Series"), instances: t.Array(t.Ref("Event")) }),
            401: messageResponse,
            422: t.Union([
              errorResponse,
              t.Object({ error: t.String(), reason: rruleInvalidReasonEnum }),
            ]),
            429: errorResponse,
          },
          detail: { operationId: "createSeries", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/:id",
        async ({ params, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const viewerId = claims?.profileId ?? null;

          const series = await runtime.runPromise(
            getSeries(params.id).pipe(
              Effect.catchTag("SeriesNotFound", () => Effect.succeed(null)),
            ),
          );
          if (series === null) {
            set.status = 404;
            return { message: "Series not found" } as const;
          }

          // For private series, only the organiser or someone who can see at
          // least one instance may see the metadata. We reuse the
          // per-event visibility gate via a synthesized row keyed on the
          // first instance so the same access rules apply.
          if (series.visibility === "private") {
            // Probe: does the viewer see any instance?
            const instances = await runtime.runPromise(
              listInstances(params.id, { scope: "all", viewerId, limit: 1 }).pipe(
                Effect.catchTag("SeriesNotFound", () => Effect.succeed([])),
              ),
            );
            if (instances.length === 0 && viewerId !== series.createdByProfileId) {
              // Viewer can't see the series. Return 404 (not 403) to avoid
              // disclosing existence — mirrors the event-level policy.
              set.status = 404;
              return { message: "Series not found" } as const;
            }
            // Also do the explicit canViewEvent gate on the first instance so
            // an invited-to-instance viewer can reach the series page.
            if (instances.length > 0) {
              const canSee = await runtime.runPromise(canViewEvent(instances[0]!, viewerId));
              if (!canSee && viewerId !== series.createdByProfileId) {
                set.status = 404;
                return { message: "Series not found" } as const;
              }
            }
          }

          return { series: serializeSeries(series) };
        },
        {
          params: t.Object({ id: t.String() }),
          response: {
            200: t.Object({ series: t.Ref("Series") }),
            404: messageResponse,
          },
          detail: { operationId: "getSeries" },
        },
      )
      .get(
        "/:id/instances",
        async ({ params, query, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const result = await runtime.runPromise(
            listInstances(params.id, {
              scope: query.scope ?? "upcoming",
              viewerId: claims?.profileId ?? null,
              limit: query.limit ? Number(query.limit) : undefined,
            }).pipe(Effect.catchTag("SeriesNotFound", () => Effect.succeed(null))),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Series not found" } as const;
          }
          return { instances: result.map(serializeEvent) };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            scope: t.Optional(
              t.Union([t.Literal("past"), t.Literal("upcoming"), t.Literal("all")]),
            ),
            limit: t.Optional(t.String()),
          }),
          response: {
            200: t.Object({ instances: t.Array(t.Ref("Event")) }),
            404: messageResponse,
          },
          detail: { operationId: "listSeriesInstances" },
        },
      )
      .patch(
        "/:id",
        async ({ params, body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          if (
            !(await checkWriteRateLimit(seriesUpdateLimiter, "series_update", claims.profileId))
          ) {
            set.status = 429;
            return { error: "Too many requests" } as const;
          }
          const result = await runtime.runPromise(
            updateSeries(params.id, body, claims.profileId).pipe(
              Effect.catchTag("SeriesNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotEventOwner", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Series not found" } as const;
          }
          if ("error" in result || "message" in result) return result;
          return { series: serializeSeries(result.series), updated: result.updated };
        },
        {
          parse: "application/json",
          params: t.Object({ id: t.String() }),
          body: t.Object({
            title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            description: t.Optional(t.String({ maxLength: 5000 })),
            location: t.Optional(t.String({ maxLength: 500 })),
            venue: t.Optional(t.String({ maxLength: 500 })),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            category: t.Optional(t.String({ maxLength: 100 })),
            imageUrl: t.Optional(t.String()),
            durationMinutes: t.Optional(t.Number({ minimum: 1, maximum: 60 * 24 * 14 })),
            visibility: visibilityEnum,
            guestListVisibility: guestListVisibilityEnum,
            joinPolicy: joinPolicyEnum,
            allowInterested: t.Optional(t.Boolean()),
            commsChannels: commsChannelsSchema,
            scope: t.Optional(t.Union([t.Literal("this_and_following"), t.Literal("all_future")])),
            from: t.Optional(t.String()),
          }),
          response: {
            200: t.Object({ series: t.Ref("Series"), updated: t.Number() }),
            401: messageResponse,
            403: messageResponse,
            404: messageResponse,
            422: errorResponse,
            429: errorResponse,
          },
          detail: { operationId: "updateSeries", security: [{ bearerAuth: [] }] },
        },
      )
      .delete(
        "/:id",
        async ({ params, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await runtime.runPromise(
            cancelSeries(params.id, claims.profileId).pipe(
              Effect.catchTag("SeriesNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotEventOwner", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Series not found" } as const;
          }
          if ("message" in result) return result;
          return result;
        },
        {
          params: t.Object({ id: t.String() }),
          response: {
            200: t.Object({ cancelled: t.Number() }),
            401: messageResponse,
            403: messageResponse,
            404: messageResponse,
          },
          detail: { operationId: "cancelSeries", security: [{ bearerAuth: [] }] },
        },
      )
  );
};
