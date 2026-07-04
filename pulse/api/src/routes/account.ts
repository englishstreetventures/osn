import { DbLive, type Db } from "@pulse/db/service";
import { extractClaims } from "@shared/osn-auth-client/verify";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL } from "../lib/jwks";
import { notifyAppLeft, verifyStepUp } from "../lib/osn-bridge";
import {
  metricPulseAccountDeletionRequested,
  metricPulseEnrollmentNotify,
  metricPulseHostCancelled,
} from "../metrics";
import * as accountErasure from "../services/accountErasure";

/**
 * Flow B — leave Pulse routes.
 *
 *   DELETE /account             — soft-delete this profile's Pulse data,
 *                                 cancel hosted events for 14 days, schedule
 *                                 hard-delete at +7 days.
 *   POST   /account/restore     — cancel a pending leave (un-cancels events
 *                                 still in their cancellation window).
 *   GET    /account/deletion-status
 *                                — UI banner support.
 *
 * Step-up validation is delegated to osn-api via the ARC `/internal/step-up/verify`
 * endpoint — pulse-api does NOT verify step-up signatures itself. The user
 * obtains the step-up token from osn-api's normal step-up ceremony with
 * `purpose=pulse_app_delete`.
 */
export const createAccountRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  return new Elysia({ prefix: "/account" })
    .delete(
      "",
      async ({ body, headers, set }) => {
        const claims = await extractClaims(headers["authorization"], jwksUrl, {
          testKey: _testKey as CryptoKey,
          audience: "osn-access",
        });
        if (!claims) {
          set.status = 401;
          metricPulseAccountDeletionRequested("error");
          return { error: "unauthorized" } as const;
        }

        const stepUpToken = body.step_up_token ?? headers["x-step-up-token"];
        if (!stepUpToken) {
          set.status = 403;
          metricPulseAccountDeletionRequested("step_up_failed");
          return { error: "step_up_required" } as const;
        }

        // S-H2: pulse-api derives the accountId server-to-server from
        // osn-api's verified `sub` claim on the step-up token rather than
        // accepting one in the request body. The accountId is never
        // visible client-side (P6 invariant — no external observer can
        // correlate two profiles to the same account).
        const verify = await Effect.runPromise(
          verifyStepUp(stepUpToken, "pulse_app_delete").pipe(
            Effect.catchAll(() => Effect.succeed({ ok: false } as const)),
          ),
        );
        if (!verify.ok) {
          set.status = 403;
          metricPulseAccountDeletionRequested("step_up_failed");
          return { error: "step_up_required" } as const;
        }
        const accountId = verify.accountId;

        try {
          const result = await runtime.runPromise(
            accountErasure.requestErasure({
              profileId: claims.profileId,
              accountId,
            }) as Effect.Effect<
              accountErasure.RequestErasureOutput,
              accountErasure.PulseErasureDbError,
              Db
            >,
          );

          metricPulseAccountDeletionRequested(result.newlyScheduled ? "ok" : "already_pending");
          // Best-effort signal that the request handler cancelled hosted
          // events; counts the user-visible side-effect even when 0.
          metricPulseHostCancelled("ok");

          // ARC callback to osn-api flipping app_enrollments.left_at.
          // Failure is swallowed and retried by the leave-app retry
          // sweeper — the user still gets 202. accountId is the
          // server-derived value from the verifyStepUp response above —
          // never client-controlled (P6 invariant).
          void runtime
            .runPromise(
              notifyAppLeft(accountId).pipe(
                Effect.tap(() => Effect.sync(() => metricPulseEnrollmentNotify("ok"))),
                Effect.catchAll(() => {
                  metricPulseEnrollmentNotify("error");
                  return Effect.void;
                }),
                Effect.flatMap(
                  () =>
                    accountErasure.markEnrollmentNotifyDone(claims.profileId) as Effect.Effect<
                      void,
                      never,
                      Db
                    >,
                ),
              ) as Effect.Effect<void, never, Db>,
            )
            .catch(() => undefined);

          set.status = 202;
          return {
            scheduled_for: result.scheduledFor,
            already_pending: !result.newlyScheduled,
          };
        } catch {
          set.status = 500;
          metricPulseAccountDeletionRequested("error");
          return { error: "internal_error" } as const;
        }
      },
      {
        // accountId is derived server-to-server from the step-up verify
        // response's verified `sub` claim (S-H2); it is intentionally
        // absent from access tokens (P6) and from this request body.
        body: t.Object({
          step_up_token: t.Optional(t.String()),
        }),
      },
    )
    .post("/restore", async ({ headers, set }) => {
      const claims = await extractClaims(headers["authorization"], jwksUrl, {
        testKey: _testKey as CryptoKey,
        audience: "osn-access",
      });
      if (!claims) {
        set.status = 401;
        return { error: "unauthorized" } as const;
      }
      try {
        const result = await runtime.runPromise(
          accountErasure.cancelErasure(claims.profileId) as Effect.Effect<
            { cancelled: boolean },
            accountErasure.PulseErasureDbError,
            Db
          >,
        );
        return { cancelled: result.cancelled };
      } catch {
        set.status = 500;
        return { error: "internal_error" } as const;
      }
    })
    .get("/deletion-status", async ({ headers, set }) => {
      const claims = await extractClaims(headers["authorization"], jwksUrl, {
        testKey: _testKey as CryptoKey,
        audience: "osn-access",
      });
      if (!claims) {
        set.status = 401;
        return { error: "unauthorized" } as const;
      }
      try {
        const status = await runtime.runPromise(
          accountErasure.getDeletionStatus(claims.profileId) as Effect.Effect<
            { scheduled: boolean } & Record<string, unknown>,
            accountErasure.PulseErasureDbError,
            Db
          >,
        );
        return status;
      } catch {
        set.status = 500;
        return { error: "internal_error" } as const;
      }
    });
};
