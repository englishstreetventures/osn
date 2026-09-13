import { DbLive, type Db } from "@osn/db/service";
import { Layer } from "effect";
import { Elysia, t } from "elysia";

import { requireArc } from "../lib/arc-middleware";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import {
  lookupProfileEmails,
  MAX_EMAIL_LOOKUP_IDS,
  type ProfileEmail,
} from "../services/account-emails";
import * as accountErasure from "../services/account-erasure";
import { joinApp } from "../services/app-enrollments";
import { createAuthService, type AuthConfig } from "../services/auth";

const AUDIENCE = "osn-api";
const SCOPE_STEP_UP_VERIFY = "step-up:verify";
const SCOPE_APP_ENROLLMENT_WRITE = "app-enrollment:write";
/**
 * Gates the address lookup and nothing else. Deliberately NOT `graph:read`:
 * an email address is the one field the graph routes are careful never to
 * return, so it gets its own grant that can be withdrawn on its own without
 * taking co-host autocomplete down with it.
 */
const SCOPE_ACCOUNT_EMAIL_READ = "account:email-read";

/**
 * The one service allowed to use that scope.
 *
 * `PERMITTED_SCOPES` in graph-internal.ts is a single flat allowlist governing
 * what /graph/internal/register-service will grant to ANY service, so holding
 * `INTERNAL_SERVICE_SECRET` is enough to register a key asking for
 * `account:email-read`. Until that allowlist is per-service, the restriction to
 * cire-api is enforced here instead — at the point of use, where the issuer is
 * signature-verified. Kept even after the registration side is fixed: a scope
 * granted by mistake still cannot be spent from the wrong service.
 */
const EMAIL_READ_ISSUER = "cire-api";

/**
 * Wire shape for one answered address. Snake_case on the wire like the rest of
 * the internal routes; the parameter carries the anonymous type and the return
 * stays inferred (same shape as `orgSummary` in organisation-internal.ts).
 */
function wireEmail(e: ProfileEmail) {
  return { profile_id: e.profileId, email: e.email };
}

/**
 * Internal endpoints called by other OSN services (Pulse, Zap, cire) over ARC:
 *
 *   POST /internal/step-up/verify — verifies that a user-supplied step-up
 *   token is valid for the requested purpose, account, and AMR. Single
 *   source of truth for step-up jti consumption across the platform.
 *
 *   POST /internal/app-enrollment/leave — flips `app_enrollments.left_at`
 *   to mark a user as having left an app. Idempotent.
 *
 *   POST /internal/accounts/emails — resolves OSN profile ids to the address
 *   of the account that owns each. The only caller is cire-api's retention
 *   sweep, which has to reach a couple whose gift detail it is about to
 *   delete and holds no address of its own. Minimisation rules live on the
 *   handler; the short version is a cap, an omit-list, and no oracle.
 *
 * Pulse / Zap must register their ARC public keys with osn-api in advance
 * (via /graph/internal/register-service) and request the `step-up:verify`
 * + `app-enrollment:write` scopes; cire-api requests `account:email-read`.
 */
export function createInternalAccountRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  const auth = createAuthService(authConfig);
  const { run } = makeAppRunner(runtime, dbLayer);

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
          // The response returns the verified accountId derived from the token's
          // `sub` claim. Pulse / Zap use this server-to-server response
          // rather than trusting a client-supplied accountId from the
          // request body. The accountId never appears in any user-facing
          // surface (P6 invariant — accountId must not leak to clients).
          const result = await run(auth.verifyStepUpForExternalPurpose(body.token, body.purpose));
          return { ok: true as const, account_id: result.accountId };
        } catch (err) {
          // The catch block surfaces a structured `reason` so callers can map distinct
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
        // is single-use. Residual risk (a compromised Pulse can
        // flip arbitrary enrollments) is mitigated by the bounded ARC
        // key TTL + per-kid rate limit.
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
    )
    .post(
      "/accounts/emails",
      async ({ body, headers, set }) => {
        // Its own scope, not `graph:read` — see SCOPE_ACCOUNT_EMAIL_READ.
        const caller = await requireArc(
          headers.authorization,
          set,
          run,
          AUDIENCE,
          SCOPE_ACCOUNT_EMAIL_READ,
        );
        if (!caller) return { error: "Unauthorized" };
        // Same 401 shape as a missing or wrong-scoped token: a service that
        // should not be here learns nothing from the difference.
        if (caller.iss !== EMAIL_READ_ISSUER) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

        try {
          const found = await run(lookupProfileEmails(body.profile_ids));
          // ALWAYS 200, ALWAYS a plain array of what could be answered. An id
          // that is unknown, tombstoned, or address-less is simply not in it,
          // and the three cases are indistinguishable — a per-id `not_found`
          // would turn this into an existence oracle for any `usr_*` id a
          // holder of the scope cared to guess.
          return { emails: found.map(wireEmail) };
        } catch {
          set.status = 500;
          return { error: "internal_error" };
        }
      },
      {
        body: t.Object({
          // The cap is enforced HERE, before the handler runs: an over-cap body
          // is a 422 that never reaches the database. `maxLength` on the id
          // bounds the request too — no real `usr_*` id is anywhere near 64
          // characters, so a longer one is a probe.
          profile_ids: t.Array(t.String({ minLength: 1, maxLength: 64 }), {
            minItems: 1,
            maxItems: MAX_EMAIL_LOOKUP_IDS,
          }),
        }),
      },
    );
}
