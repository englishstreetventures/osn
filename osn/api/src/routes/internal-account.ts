import { DbLive, type Db } from "@osn/db/service";
import { Effect, Layer } from "effect";
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
import { APP_STEP_UP_ISSUER } from "../services/auth/app-step-up";
import { isAuthError } from "../services/auth/errors";

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

/** The one service that may spend each downstream deletion purpose. */
const PURPOSE_ISSUER = {
  pulse_app_delete: "pulse-api",
  zap_app_delete: "zap-api",
  ...APP_STEP_UP_ISSUER,
} as const;

/** Lowercase hex SHA-256: a request's binding. */
const HEX_SHA256 = "^[0-9a-f]{64}$";

/** A random id or code as osn-api makes them: base64url, no padding. */
const BASE64URL = "^[A-Za-z0-9_-]+$";

/** The tag of a failure a route runner threw, for a log line: one of a fixed set of error classes. */
const errorTag = (err: unknown): string => {
  const tag = err && typeof err === "object" && "_tag" in err ? err._tag : undefined;
  return typeof tag === "string" ? tag : "unknown";
};

/**
 * The service each app's enrolment belongs to, by its ARC issuer
 * (`pulse/api/src/app.ts` and `zap/api/src/app.ts` `SERVICE_NAME`). A join
 * or leave is written only for the calling service's own app: the join's
 * refusal for a pending deletion sends that app's purge back on the job, so
 * one service must not be able to move another's.
 */
const APP_ISSUER = { pulse: "pulse-api", zap: "zap-api" } as const satisfies Record<
  "pulse" | "zap",
  string
>;

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
 *   token is valid for the requested purpose and AMR, that it is of the
 *   account owning the profile the calling service verified, and that the
 *   session family that minted it still has a live session. Each purpose is
 *   spendable by its own app only. Single source of truth for step-up jti
 *   consumption across the platform. No user session reaches OSN on this
 *   hop, so the token's own binding is the session check. For cire's
 *   purpose it verifies an app step-up request instead (below), and answers
 *   every profile of the account as well.
 *
 *   POST /internal/step-up/requests — begins an app step-up request
 *   (`services/auth/app-step-up.ts`): the person confirms it on Musubi, and
 *   the app verifies it at `/step-up/verify`. For an app whose own pages
 *   cannot run a step-up: cire's organiser portal holds no OSN token.
 *
 *   POST /internal/app-enrollment/leave — flips `app_enrollments.left_at`
 *   to mark a user as having left an app. Idempotent.
 *
 *   POST /internal/accounts/emails — resolves OSN profile ids to the address
 *   of the account that owns each. The only caller is cire-api, which holds
 *   no address of its own and mails a wedding's organisers: its retention
 *   sweep reaches a couple whose gift detail it is about to delete, its
 *   daily RSVP digest reaches a wedding's owner and editor co-hosts, and its
 *   owner notices reach a wedding's owners (and an owner just removed) when
 *   ownership changes or the wedding is deleted.
 *   Minimisation rules live on the handler; the short version is a cap, an
 *   omit-list, and no oracle.
 *
 * Pulse / Zap must register their ARC public keys with osn-api in advance
 * (via /graph/internal/register-service) and request the `step-up:verify`
 * + `app-enrollment:write` scopes; cire-api requests `account:email-read`
 * and `step-up:verify`.
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
        // Each app spends only the purpose of its own deletion, refused before
        // the token is read, so nothing is claimed.
        if (caller.iss !== PURPOSE_ISSUER[body.purpose]) {
          return { ok: false as const, reason: "invalid" as const };
        }

        // cire's purpose is spent through an app step-up request only, and
        // Pulse's and Zap's through a token only: neither form reaches the
        // other's verifier.
        if (body.purpose === "cire_app_delete") {
          const request = body.request;
          if (!request || body.token !== undefined) {
            return { ok: false as const, reason: "invalid" as const };
          }
          try {
            const verified = await run(
              auth.verifyAppStepUp({
                requestId: request.id,
                purpose: body.purpose,
                profileId: body.profile_id,
                binding: request.binding,
                code: request.code,
              }),
            );
            if (!verified.ok) return { ok: false as const, reason: "invalid" as const };
            // The account's profile ids go only to the app the person
            // confirmed for, so it can reach every profile they asked it to.
            return {
              ok: true as const,
              account_id: verified.accountId,
              profile_ids: verified.profileIds,
            };
          } catch (err) {
            await run(
              Effect.logError("internal step-up request verify failed").pipe(
                Effect.annotateLogs({ tag: errorTag(err) }),
              ),
            );
            set.status = 500;
            return { error: "internal_error" };
          }
        }
        if (body.token === undefined || body.request !== undefined) {
          return { ok: false as const, reason: "invalid" as const };
        }
        const token = body.token;

        try {
          // The response returns the verified accountId derived from the token's
          // `sub` claim. Pulse / Zap use this server-to-server response
          // rather than trusting a client-supplied accountId from the
          // request body. The accountId never appears in any user-facing
          // surface (P6 invariant — accountId must not leak to clients).
          // `profile_id` is the profile the service verified its caller as;
          // the token must be of the account that owns it.
          const result = await run(
            auth.verifyStepUpForExternalPurpose(token, body.purpose, body.profile_id),
          );
          return { ok: true as const, account_id: result.accountId };
        } catch (err) {
          // A database fault is a 500, not a refusal: the token was not judged.
          if (!isAuthError(err)) {
            await run(
              Effect.logError("internal step-up verify failed").pipe(
                Effect.annotateLogs({ tag: errorTag(err) }),
              ),
            );
            set.status = 500;
            return { error: "internal_error" };
          }
          // A refusal surfaces a structured `reason` so callers can map distinct
          // failures to precise client-facing errors. Specific result types
          // are recorded in `osn.auth.step_up.verified` by verifyStepUpToken.
          const reason: "consumed" | "invalid" =
            err.message === "Step-up token already used" ? "consumed" : "invalid";
          return { ok: false as const, reason };
        }
      },
      {
        body: t.Object({
          token: t.Optional(t.String({ minLength: 1 })),
          // An app step-up request, as `/step-up/requests` began it and the
          // person confirmed it: its id, the hash of the app's browser secret,
          // and the code Musubi handed that browser.
          request: t.Optional(
            t.Object({
              id: t.String({ minLength: 1, maxLength: 64, pattern: BASE64URL }),
              binding: t.String({ pattern: HEX_SHA256 }),
              code: t.String({ minLength: 1, maxLength: 64, pattern: BASE64URL }),
            }),
          ),
          // The downstream apps' own deletions only. Account deletion spends
          // its token at `DELETE /account`, behind the caller's live session.
          purpose: t.Union([
            t.Literal("pulse_app_delete"),
            t.Literal("zap_app_delete"),
            t.Literal("cire_app_delete"),
          ]),
          // No real `usr_*` id is anywhere near 64 characters.
          profile_id: t.String({ minLength: 1, maxLength: 64 }),
        }),
      },
    )
    .post(
      "/step-up/requests",
      async ({ body, headers, set }) => {
        const caller = await requireArc(
          headers.authorization,
          set,
          run,
          AUDIENCE,
          SCOPE_STEP_UP_VERIFY,
        );
        if (!caller) return { error: "Unauthorized" };
        // Only the app the purpose belongs to may ask for it.
        if (caller.iss !== APP_STEP_UP_ISSUER[body.purpose]) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        try {
          const begun = await run(
            auth.beginAppStepUp({
              profileId: body.profile_id,
              purpose: body.purpose,
              binding: body.binding,
              returnTo: body.return_to,
            }),
          );
          if (begun.ok) return { request_id: begun.requestId };
          set.status =
            begun.reason === "not_found" ? 404 : begun.reason === "unavailable" ? 503 : 400;
          return { error: begun.reason };
        } catch (err) {
          await run(
            Effect.logError("internal step-up request begin failed").pipe(
              Effect.annotateLogs({ tag: errorTag(err) }),
            ),
          );
          set.status = 500;
          return { error: "internal_error" };
        }
      },
      {
        body: t.Object({
          purpose: t.Literal("cire_app_delete"),
          profile_id: t.String({ minLength: 1, maxLength: 64 }),
          // Hex SHA-256 of a secret the app's cookie holds in the asking browser.
          binding: t.String({ pattern: HEX_SHA256 }),
          // Where Musubi sends the person once they confirm: the app's portal.
          return_to: t.String({ minLength: 1, maxLength: 2048 }),
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
        // Same 401 as a missing token: only the app's own service.
        if (caller.iss !== APP_ISSUER[body.app]) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

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
        // Same 401 as a missing token: only the app's own service.
        if (caller.iss !== APP_ISSUER[body.app]) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

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
