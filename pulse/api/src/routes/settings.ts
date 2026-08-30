import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { makeCallerResolver } from "../lib/caller";
import { DEFAULT_VERIFICATION, type OsnTokenVerification } from "../lib/jwks";
import { metricSettingsUpdated } from "../metrics";
import { updateSettings } from "../services/pulseUsers";

/**
 * Pulse per-user settings route (`PATCH /me/settings`).
 *
 * Split out of `routes/events.ts` (2026-07 quality review) — it is a distinct
 * `/me`-prefixed concern with its own factory, not part of the `/events`
 * surface. Kept behaviourally identical; only its home moved.
 */
export const createSettingsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  verification: OsnTokenVerification = DEFAULT_VERIFICATION,
  _testKey?: CryptoKey,
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  const resolveCaller = makeCallerResolver({ runtime, verification, testKey: _testKey });
  return new Elysia({ prefix: "/me" }).patch(
    "/settings",
    async ({ body, headers, set }) => {
      const claims = await resolveCaller(headers);
      if (!claims) {
        metricSettingsUpdated("attendance_visibility", "unauthorized");
        set.status = 401;
        return { message: "Unauthorized" } as const;
      }
      const result = await runtime.runPromise(
        updateSettings(claims.profileId, body).pipe(
          Effect.catchTag("ValidationError", (e) =>
            Effect.sync(() => {
              set.status = 422;
              return { error: String(e.cause) } as const;
            }),
          ),
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
      parse: "application/json",
      body: t.Object({
        attendanceVisibility: t.Optional(t.Union([t.Literal("connections"), t.Literal("no_one")])),
      }),
      response: {
        200: t.Object({
          settings: t.Object({
            profileId: t.String(),
            attendanceVisibility: t.Union([t.Literal("connections"), t.Literal("no_one")]),
          }),
        }),
        401: t.Object({ message: t.String() }),
        422: t.Object({ error: t.String() }),
      },
      detail: { operationId: "updateSettings", security: [{ bearerAuth: [] }] },
    },
  );
};
