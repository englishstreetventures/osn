import { DbLive, type Db } from "@osn/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { requireArc } from "../lib/arc-middleware";
import * as accountErasure from "../services/account-erasure";
import { joinApp } from "../services/app-enrollments";
import { createAuthService, type AuthConfig } from "../services/auth";

const AUDIENCE = "osn-api";
const SCOPE_STEP_UP_VERIFY = "step-up:verify";
const SCOPE_APP_ENROLLMENT_WRITE = "app-enrollment:write";

/**
 * Internal endpoints called by other OSN services (Pulse, Zap) over ARC:
 *
 *   POST /internal/step-up/verify — verifies that a user-supplied step-up
 *   token is valid for the requested purpose, account, and AMR. Single
 *   source of truth for step-up jti consumption across the platform.
 *
 *   POST /internal/app-enrollment/leave — flips `app_enrollments.left_at`
 *   to mark a user as having left an app. Idempotent.
 *
 * Pulse / Zap must register their ARC public keys with osn-api in advance
 * (via /graph/internal/register-service) and request the `step-up:verify`
 * + `app-enrollment:write` scopes.
 */
export function createInternalAccountRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
) {
  const auth = createAuthService(authConfig);
  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

  return new Elysia({ prefix: "/internal" })
    .post(
      "/step-up/verify",
      async ({ body, headers, set }) => {
        const caller = await requireArc(
          headers.authorization,
          set,
          run,
          AUDIENCE,
          SCOPE_STEP_UP_VERIFY,
        );
        if (!caller) return { error: "Unauthorized" };

        try {
          // S-H2: returns the verified accountId derived from the token's
          // `sub` claim. Pulse / Zap use this server-to-server response
          // rather than trusting a client-supplied accountId from the
          // request body. The accountId never appears in any user-facing
          // surface (P6 invariant — accountId must not leak to clients).
          const result = await run(auth.verifyStepUpForExternalPurpose(body.token, body.purpose));
          return { ok: true as const, account_id: result.accountId };
        } catch (err) {
          // S-M1: surface a structured `reason` so callers can map distinct
          // failures to precise client-facing errors. Specific result types
          // are recorded in `osn.auth.step_up.verified` by verifyStepUpToken.
          const message =
            err && typeof err === "object" && "message" in err && typeof err.message === "string"
              ? err.message
              : "";
          let reason: "consumed" | "invalid" = "invalid";
          if (message === "Step-up token already used") reason = "consumed";
          return { ok: false as const, reason };
        }
      },
      {
        body: t.Object({
          token: t.String({ minLength: 1 }),
          purpose: t.Union([
            t.Literal("pulse_app_delete"),
            t.Literal("zap_app_delete"),
            t.Literal("account_delete"),
          ]),
        }),
      },
    )
    .post(
      "/app-enrollment/leave",
      async ({ body, headers, set }) => {
        const caller = await requireArc(
          headers.authorization,
          set,
          run,
          AUDIENCE,
          SCOPE_APP_ENROLLMENT_WRITE,
        );
        if (!caller) return { error: "Unauthorized" };

        // ARC authenticates "Pulse / Zap made this call". User intent was
        // proved by the matching `/internal/step-up/verify` call earlier
        // in the request lifecycle (the verify-then-leave pattern); we
        // can't re-verify the same step-up token here because the JTI
        // is single-use. Residual S-H3 risk (a compromised Pulse can
        // flip arbitrary enrollments) is mitigated by the bounded ARC
        // key TTL + per-kid rate limit (backlogged as S-M24).
        try {
          const result = await run(
            accountErasure.recordAppEnrollmentLeft(body.account_id, body.app),
          );
          return { closed: result.closed };
        } catch {
          set.status = 500;
          return { error: "internal_error" };
        }
      },
      {
        body: t.Object({
          account_id: t.String({ minLength: 1 }),
          app: t.Union([t.Literal("pulse"), t.Literal("zap")]),
        }),
      },
    )
    .post(
      "/app-enrollment/join",
      async ({ body, headers, set }) => {
        // Lazy provisioning hook for first-authenticated-call flows. Pulse
        // calls this on a user's first authenticated Pulse API call (after
        // the user re-engages post-leave or on initial onboarding). No
        // step-up is required because joining an app doesn't mutate
        // identity-side state in a way that can harm the user — it just
        // unblocks future leave-app callbacks targeting that app.
        const caller = await requireArc(
          headers.authorization,
          set,
          run,
          AUDIENCE,
          SCOPE_APP_ENROLLMENT_WRITE,
        );
        if (!caller) return { error: "Unauthorized" };

        try {
          const result = await run(joinApp(body.account_id, body.app));
          return { enrolled: result.enrolled };
        } catch {
          set.status = 500;
          return { error: "internal_error" };
        }
      },
      {
        body: t.Object({
          account_id: t.String({ minLength: 1 }),
          app: t.Union([t.Literal("pulse"), t.Literal("zap")]),
        }),
      },
    );
}
