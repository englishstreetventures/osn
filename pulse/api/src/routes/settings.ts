import { DbLive, type Db } from "@pulse/db/service";
import { extractClaims } from "@shared/osn-auth-client/verify";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL } from "../lib/jwks";
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
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  return new Elysia({ prefix: "/me" }).patch(
    "/settings",
    async ({ body, headers, set }) => {
      const claims = await extractClaims(headers["authorization"], jwksUrl, {
        testKey: _testKey as CryptoKey,
        audience: "osn-access",
      });
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
      body: t.Object({
        attendanceVisibility: t.Optional(t.Union([t.Literal("connections"), t.Literal("no_one")])),
      }),
    },
  );
};
