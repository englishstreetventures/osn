import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";
import { decodeProtectedHeader, jwtVerify } from "jose";

import { resolvePublicKeyForKid, refreshPublicKeyForKid } from "../lib/jwks-cache";
import { MAX_EVENT_GUESTS } from "../lib/limits";
import {
  metricCalendarIcsGenerated,
  metricEventAccessDenied,
  metricSettingsUpdated,
} from "../metrics";
import { buildIcs } from "../services/calendar";
import { listBlasts, parseCommsChannels, sendBlast } from "../services/comms";
import { loadVisibleEvent } from "../services/eventAccess";
import {
  createEvent,
  deleteEvent,
  listEvents,
  listTodayEvents,
  updateEvent,
} from "../services/events";
import { updateSettings } from "../services/pulseUsers";
import {
  inviteGuests,
  latestRsvps,
  listRsvps,
  rsvpCounts,
  upsertRsvp,
  type RsvpWithProfile,
} from "../services/rsvps";

const visibilityEnum = t.Optional(t.Union([t.Literal("public"), t.Literal("private")]));
const guestListVisibilityEnum = t.Optional(
  t.Union([t.Literal("public"), t.Literal("connections"), t.Literal("private")]),
);
const joinPolicyEnum = t.Optional(t.Union([t.Literal("open"), t.Literal("guest_list")]));
const commsChannelsSchema = t.Optional(
  t.Array(t.Union([t.Literal("sms"), t.Literal("email")]), { minItems: 1, maxItems: 2 }),
);
const rsvpStatusEnum = t.Union([
  t.Literal("going"),
  t.Literal("interested"),
  t.Literal("not_going"),
]);
const rsvpFilterStatusEnum = t.Union([
  t.Literal("going"),
  t.Literal("interested"),
  t.Literal("not_going"),
  t.Literal("invited"),
]);

/**
 * Serialises an RSVP row for the wire. Visibility is enforced upstream
 * by `listRsvps` (per-row attendee privacy + coarse guest-list rules);
 * this function only shapes the response.
 *
 * `invitedByProfileId` is gated to the organiser viewer — non-organiser
 * viewers don't need (or want) to know which co-host invited each
 * attendee. The DB column stays populated; only the wire format hides
 * it from non-organisers.
 */
const serializeRsvp = (row: RsvpWithProfile, isOrganiser: boolean) => ({
  id: row.id,
  eventId: row.eventId,
  profileId: row.profileId,
  status: row.status,
  invitedByProfileId: isOrganiser ? row.invitedByProfileId : null,
  isCloseFriend: row.isCloseFriend,
  createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  profile: row.profile
    ? {
        id: row.profile.id,
        handle: row.profile.handle,
        displayName: row.profile.displayName,
        avatarUrl: row.profile.avatarUrl,
      }
    : null,
});

const statusEnum = t.Optional(
  t.Union([
    t.Literal("upcoming"),
    t.Literal("ongoing"),
    t.Literal("maybe_finished"),
    t.Literal("finished"),
    t.Literal("cancelled"),
  ]),
);

type Claims = {
  profileId: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
};

/**
 * Verifies token signature with a pre-resolved key. Returns claims or null.
 * P-W1: accepts pre-decoded kid to avoid re-parsing the JWT header.
 */
async function verifyTokenWithKey(token: string, key: CryptoKey): Promise<Claims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"] });
    const profileId = typeof payload.sub === "string" ? payload.sub : null;
    if (!profileId) return null;
    return {
      profileId,
      email: typeof payload.email === "string" ? payload.email : null,
      handle: typeof payload.handle === "string" ? payload.handle : null,
      displayName: typeof payload.displayName === "string" ? payload.displayName : null,
    };
  } catch {
    return null;
  }
}

/** Extracts verified claims from a Bearer token. Returns null on any failure. */
async function extractClaims(
  authHeader: string | undefined,
  jwksUrl: string,
  _testKey?: CryptoKey,
): Promise<Claims | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  // P-W1: decode the JWT header exactly once regardless of code path.
  let header: { kid?: string; alg?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string") return null;
  const kid = header.kid;

  if (_testKey) {
    return verifyTokenWithKey(token, _testKey);
  }

  // Try cached key first; on failure, refresh once (handles rotation).
  const key = await resolvePublicKeyForKid(kid, jwksUrl);
  if (key) {
    const result = await verifyTokenWithKey(token, key);
    if (result) return result;
  }

  // Verification failed — refresh key in case it was rotated, then retry.
  const freshKey = await refreshPublicKeyForKid(kid, jwksUrl);
  if (!freshKey) return null;
  return verifyTokenWithKey(token, freshKey);
}

const DEFAULT_JWKS_URL = process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";

export const createEventsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) => {
  return (
    new Elysia({ prefix: "/events" })
      .get(
        "/",
        async ({ query, headers }) => {
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          const result = await Effect.runPromise(
            listEvents({ ...query, viewerId: claims?.profileId ?? null }).pipe(
              Effect.provide(dbLayer),
            ),
          );
          return { events: result };
        },
        {
          query: t.Object({
            status: statusEnum,
            category: t.Optional(t.String()),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get("/today", async () => {
        const result = await Effect.runPromise(listTodayEvents.pipe(Effect.provide(dbLayer)));
        return { events: result };
      })
      .get(
        "/:id",
        async ({ params, headers, set }) => {
          // S-H1: gate direct fetch by visibility. Private events are
          // only returned to the organiser or to invited / RSVP'd users.
          // 404 (not 403) for non-authorised viewers so we don't leak
          // existence.
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          const result = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (result === null) {
            metricEventAccessDenied(
              "get",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" };
          }
          return { event: result };
        },
        {
          params: t.Object({
            id: t.String(),
          }),
        },
      )
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
            createEvent(body, creator).pipe(
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if ("error" in result) return result;
          set.status = 201;
          return { event: result };
        },
        {
          body: t.Object({
            title: t.String(),
            description: t.Optional(t.String()),
            location: t.Optional(t.String()),
            venue: t.Optional(t.String()),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            category: t.Optional(t.String()),
            startTime: t.String({ format: "date-time" }),
            endTime: t.Optional(t.String({ format: "date-time" })),
            status: statusEnum,
            imageUrl: t.Optional(t.String()),
            visibility: visibilityEnum,
            guestListVisibility: guestListVisibilityEnum,
            joinPolicy: joinPolicyEnum,
            allowInterested: t.Optional(t.Boolean()),
            commsChannels: commsChannelsSchema,
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
          const profileId = claims.profileId;
          const result = await Effect.runPromise(
            updateEvent(params.id, body, profileId).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
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
            return { message: "Event not found" };
          }
          if ("error" in result) return result;
          if ("message" in result) return result;
          return { event: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            title: t.Optional(t.String()),
            description: t.Optional(t.String()),
            location: t.Optional(t.String()),
            venue: t.Optional(t.String()),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            category: t.Optional(t.String()),
            startTime: t.Optional(t.String({ format: "date-time" })),
            endTime: t.Optional(t.String({ format: "date-time" })),
            status: statusEnum,
            imageUrl: t.Optional(t.String()),
            visibility: visibilityEnum,
            guestListVisibility: guestListVisibilityEnum,
            joinPolicy: joinPolicyEnum,
            allowInterested: t.Optional(t.Boolean()),
            commsChannels: commsChannelsSchema,
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
          const profileId = claims.profileId;
          const result = await Effect.runPromise(
            deleteEvent(params.id, profileId).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
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
            return { message: "Event not found" };
          }
          if (result != null && "message" in result) return result;
          set.status = 204;
          return null;
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      // ── RSVPs ────────────────────────────────────────────────────────────
      .get(
        "/:id/rsvps",
        async ({ params, query, headers, set }) => {
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          const viewerId = claims?.profileId ?? null;
          // Visibility gate first — private events are 404 to non-viewers.
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, viewerId).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "rsvps",
              viewerId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const isOrganiser = viewerId != null && viewerId === event.createdByProfileId;
          const result = await Effect.runPromise(
            listRsvps(params.id, viewerId, {
              status: query.status,
              limit: query.limit ? Number(query.limit) : undefined,
            }).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Failed to list RSVPs" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          if (
            result != null &&
            !Array.isArray(result) &&
            typeof result === "object" &&
            "error" in result
          ) {
            return result;
          }
          return {
            rsvps: (result as RsvpWithProfile[]).map((row) => serializeRsvp(row, isOrganiser)),
          };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            status: t.Optional(rsvpFilterStatusEnum),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/:id/rsvps/counts",
        async ({ params, headers, set }) => {
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          // S-H5: gate counts by visibility — leaking the existence /
          // activity of a private event is its own information disclosure.
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "rsvps_counts",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const result = await Effect.runPromise(
            rsvpCounts(params.id).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          return { counts: result };
        },
        { params: t.Object({ id: t.String() }) },
      )
      .get(
        "/:id/rsvps/latest",
        async ({ params, query, headers, set }) => {
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          const viewerId = claims?.profileId ?? null;
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, viewerId).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const isOrganiser = viewerId != null && viewerId === event.createdByProfileId;
          const limit = query.limit ? Math.min(Math.max(1, Number(query.limit)), 20) : 5;
          const result = await Effect.runPromise(
            latestRsvps(params.id, viewerId, limit).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Failed to list RSVPs" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          if (
            result != null &&
            !Array.isArray(result) &&
            typeof result === "object" &&
            "error" in result
          ) {
            return result;
          }
          return {
            rsvps: (result as RsvpWithProfile[]).map((row) => serializeRsvp(row, isOrganiser)),
          };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({ limit: t.Optional(t.String()) }),
        },
      )
      .post(
        "/:id/rsvps",
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
            upsertRsvp(params.id, claims.profileId, body).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotInvited", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Invitation required" } as const;
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
            return { message: "Event not found" } as const;
          }
          if ("message" in result || "error" in result) return result;
          return { rsvp: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ status: rsvpStatusEnum }),
        },
      )
      .post(
        "/:id/invite",
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
            inviteGuests(params.id, claims.profileId, body).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
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
            return { message: "Event not found" } as const;
          }
          return result;
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            profileIds: t.Array(t.String(), { minItems: 1, maxItems: MAX_EVENT_GUESTS }),
          }),
        },
      )
      // ── Add to calendar ─────────────────────────────────────────────────
      .get(
        "/:id/ics",
        async ({ params, headers, set }) => {
          // S-H2: gate ICS export by visibility. Otherwise the file
          // download leaks event metadata (incl. GEO coordinates) for
          // private events to anyone with the URL.
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "ics",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const ics = buildIcs(event);
          metricCalendarIcsGenerated("ok");
          set.headers["content-type"] = "text/calendar; charset=utf-8";
          set.headers["content-disposition"] = `attachment; filename="${event.id}.ics"`;
          return ics;
        },
        { params: t.Object({ id: t.String() }) },
      )
      // ── Comms (stubbed) ─────────────────────────────────────────────────
      .get(
        "/:id/comms",
        async ({ params, headers, set }) => {
          // S-H3: gate comms by visibility. Blast bodies often contain
          // venue codes, addresses, dress codes — they should never be
          // visible to viewers who can't see the event.
          const claims = await extractClaims(
            headers["authorization"],
            jwksUrl,
            _testKey as CryptoKey,
          );
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "comms",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const blasts = await Effect.runPromise(
            listBlasts(params.id, 10).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed([])),
              Effect.provide(dbLayer),
            ),
          );
          return {
            channels: parseCommsChannels(event.commsChannels),
            blasts: blasts.map((b) => ({
              id: b.id,
              channel: b.channel,
              body: b.body,
              sentByProfileId: b.sentByProfileId,
              sentAt: b.sentAt instanceof Date ? b.sentAt.toISOString() : b.sentAt,
              createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : b.createdAt,
            })),
          };
        },
        { params: t.Object({ id: t.String() }) },
      )
      .post(
        "/:id/comms/blasts",
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
            sendBlast(params.id, claims.profileId, body).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
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
            return { message: "Event not found" } as const;
          }
          if ("message" in result || "error" in result) return result;
          set.status = 201;
          return {
            blasts: result.blasts.map((b) => ({
              id: b.id,
              channel: b.channel,
              body: b.body,
              sentAt: b.sentAt instanceof Date ? b.sentAt.toISOString() : b.sentAt,
            })),
          };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            channels: t.Array(t.Union([t.Literal("sms"), t.Literal("email")]), {
              minItems: 1,
              maxItems: 2,
            }),
            body: t.String({ minLength: 1, maxLength: 1600 }),
          }),
        },
      )
  );
};

// ---------------------------------------------------------------------------
// /me/settings (Pulse-side user settings)
// ---------------------------------------------------------------------------

export const createSettingsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) => {
  return new Elysia({ prefix: "/me" }).patch(
    "/settings",
    async ({ body, headers, set }) => {
      const claims = await extractClaims(headers["authorization"], jwksUrl, _testKey as CryptoKey);
      if (!claims) {
        metricSettingsUpdated("attendance_visibility", "unauthorized");
        set.status = 401;
        return { message: "Unauthorized" } as const;
      }
      const result = await Effect.runPromise(
        updateSettings(claims.profileId, body).pipe(
          Effect.catchTag("ValidationError", (e) =>
            Effect.sync(() => {
              set.status = 422;
              return { error: String(e.cause) } as const;
            }),
          ),
          Effect.provide(dbLayer),
        ),
      );
      if ("error" in result) {
        metricSettingsUpdated("attendance_visibility", "validation_error");
        return result;
      }
      metricSettingsUpdated("attendance_visibility", "ok");
      return {
        settings: {
          profileId: result.profileId,
          attendanceVisibility: result.attendanceVisibility,
        },
      };
    },
    {
      body: t.Object({
        attendanceVisibility: t.Optional(t.Union([t.Literal("connections"), t.Literal("no_one")])),
      }),
    },
  );
};

export const eventsRoutes = createEventsRoutes();
export const settingsRoutes = createSettingsRoutes();
