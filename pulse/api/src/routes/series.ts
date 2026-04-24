import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL, extractClaims } from "../lib/auth";
import { canViewEvent } from "../services/eventAccess";
import {
  cancelSeries,
  createSeries,
  getSeries,
  listInstances,
  updateSeries,
} from "../services/series";

const visibilityEnum = t.Optional(t.Union([t.Literal("public"), t.Literal("private")]));
const guestListVisibilityEnum = t.Optional(
  t.Union([t.Literal("public"), t.Literal("connections"), t.Literal("private")]),
);
const joinPolicyEnum = t.Optional(t.Union([t.Literal("open"), t.Literal("guest_list")]));
const commsChannelsSchema = t.Optional(
  t.Array(t.Union([t.Literal("sms"), t.Literal("email")]), { minItems: 1, maxItems: 2 }),
);

export const createSeriesRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) => {
  return new Elysia({ prefix: "/series" })
    .post(
      "/",
      async ({ body, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const creator = {
          createdByProfileId: claims.profileId,
          createdByName:
            claims.displayName ??
            (claims.handle ? `@${claims.handle}` : null) ??
            (claims.email ? (claims.email.split("@")[0] ?? null) : null),
          createdByAvatar: null,
        };
        const result = await Effect.runPromise(
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
            Effect.provide(dbLayer),
          ),
        );
        if ("error" in result) return result;
        set.status = 201;
        return result;
      },
      {
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
      },
    )
    .get(
      "/:id",
      async ({ params, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        const viewerId = claims?.profileId ?? null;

        const series = await Effect.runPromise(
          getSeries(params.id).pipe(
            Effect.catchTag("SeriesNotFound", () => Effect.succeed(null)),
            Effect.provide(dbLayer),
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
          const instances = await Effect.runPromise(
            listInstances(params.id, { scope: "all", viewerId, limit: 1 }).pipe(
              Effect.catchTag("SeriesNotFound", () => Effect.succeed([])),
              Effect.provide(dbLayer),
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
            const canSee = await Effect.runPromise(
              canViewEvent(instances[0]!, viewerId).pipe(Effect.provide(dbLayer)),
            );
            if (!canSee && viewerId !== series.createdByProfileId) {
              set.status = 404;
              return { message: "Series not found" } as const;
            }
          }
        }

        return { series };
      },
      { params: t.Object({ id: t.String() }) },
    )
    .get(
      "/:id/instances",
      async ({ params, query, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        const result = await Effect.runPromise(
          listInstances(params.id, {
            scope: query.scope ?? "upcoming",
            viewerId: claims?.profileId ?? null,
            limit: query.limit ? Number(query.limit) : undefined,
          }).pipe(
            Effect.catchTag("SeriesNotFound", () => Effect.succeed(null)),
            Effect.provide(dbLayer),
          ),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Series not found" } as const;
        }
        return { instances: result };
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          scope: t.Optional(t.Union([t.Literal("past"), t.Literal("upcoming"), t.Literal("all")])),
          limit: t.Optional(t.String()),
        }),
      },
    )
    .patch(
      "/:id",
      async ({ params, body, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const result = await Effect.runPromise(
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
            Effect.provide(dbLayer),
          ),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Series not found" } as const;
        }
        if ("error" in result || "message" in result) return result;
        return result;
      },
      {
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
      },
    )
    .delete(
      "/:id",
      async ({ params, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const result = await Effect.runPromise(
          cancelSeries(params.id, claims.profileId).pipe(
            Effect.catchTag("SeriesNotFound", () => Effect.succeed(null)),
            Effect.catchTag("NotEventOwner", () =>
              Effect.sync(() => {
                set.status = 403;
                return { message: "Forbidden" } as const;
              }),
            ),
            Effect.provide(dbLayer),
          ),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Series not found" } as const;
        }
        if ("message" in result) return result;
        return result;
      },
      { params: t.Object({ id: t.String() }) },
    );
};

export const seriesRoutes = createSeriesRoutes();
