import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import {
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal, resolveAccountWindowPrincipal } from "../lib/auth-derive";
import type { CookieSessionConfig } from "../lib/cookie-session";
import { createLiveSessionCheck } from "../lib/live-session";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { metricAccountDeletionRequested, metricAuthRateLimited } from "../metrics";
import * as accountErasure from "../services/account-erasure";
import { createAuthService, type AuthConfig } from "../services/auth";
import { isAuthError } from "../services/auth/errors";
import { memoryLimiter, OSN_RATE_LIMITS } from "./auth/limiters";
import {
  accountDeletionBadRequestResponse,
  accountDeletionConflictResponse,
  accountDeletionPreviewResponse,
  accountDeletionScheduledResponse,
  accountDeletionStatusResponse,
  accountRestoreResponse,
  errorResponse,
  stepUpRequiredResponse,
} from "./auth/response-schemas";

/**
 * Per-account rate limits for the deletion endpoints. Tighter than the
 * normal auth surface because each call is a destructive ceremony — the
 * step-up gate is the primary defence; the limiter just curbs noise. The
 * deletion preview spends `accountDeletionStatus`.
 */
export interface AccountErasureRateLimiters {
  readonly accountDelete: RateLimiterBackend;
  readonly accountRestore: RateLimiterBackend;
  readonly accountDeletionStatus: RateLimiterBackend;
}

/** The in-memory bundle, single process only. Budgets are in `OSN_RATE_LIMITS`. */
export function createDefaultAccountErasureRateLimiters(): AccountErasureRateLimiters {
  return {
    accountDelete: memoryLimiter(OSN_RATE_LIMITS.accountDelete),
    accountRestore: memoryLimiter(OSN_RATE_LIMITS.accountRestore),
    accountDeletionStatus: memoryLimiter(OSN_RATE_LIMITS.accountDeletionStatus),
  };
}

/**
 * Flow A — full OSN account erasure. The user holds an OSN access token
 * + a fresh step-up token. After verification the service tombstones the
 * account; the cross-service fan-out runs from the sweeper once the grace
 * window closes. Restore cancels a pending deletion with its own step-up.
 */
export function createAccountErasureRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db | EmailService> = Layer.merge(DbLive, makeLogEmailLive().layer),
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiters: AccountErasureRateLimiters = createDefaultAccountErasureRateLimiters(),
  cookieConfig: CookieSessionConfig = { secure: false },
  /**
   * Client-IP trust policy. See `createAuthRoutes` for the
   * full contract. Defaults to `{}` (direct mode, socket peer only).
   */
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  const auth = createAuthService(authConfig);
  const rl = rateLimiters;

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));
  const { liveSession, liveSessionGate } = createLiveSessionCheck({ auth, run, cookieConfig });

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  /** Per-request transport socket peer; `null` under `app.handle`. */
  type IpCtx = {
    server: { requestIP?: (req: Request) => { address?: string } | null } | null;
    request: Request;
  };
  const socketIpOf = (ctx: IpCtx): string | null =>
    ctx.server?.requestIP?.(ctx.request)?.address ?? null;

  async function rateLimit(
    headers: Record<string, string | undefined>,
    socketIp: string | null,
    endpoint:
      | "account_delete"
      | "account_restore"
      | "account_deletion_status"
      | "account_deletion_preview",
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = getClientIp(headers, { ...clientIpConfig, socketIp });
    // Never key the limiter on an unresolved IP — deny instead of
    // sharing one bucket across all un-attributable requests.
    if (isUnresolvedIp(ip)) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    let allowed: boolean;
    try {
      allowed = await limiter.check(ip);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    return null;
  }

  /** An owned organisation as the open action the preview and a 409 show. */
  const toOpenAction = (org: accountErasure.OwnedOrganisation) => ({
    id: accountErasure.organisationActionId(org.orgId),
    app: "osn",
    kind: "organisation_owned",
    label: `You own ${org.name} (@${org.handle}).`,
    choices: accountErasure.organisationChoices(org).map((choice) => ({
      choice,
      description:
        choice === "transfer"
          ? `@${org.successor?.handle ?? ""} becomes the owner.`
          : choice === "successor"
            ? "The member you name becomes the owner."
            : "The organisation and its memberships are deleted.",
    })),
    default_choice: accountErasure.organisationDefaultChoice(org),
    erased_on: null,
    link: null,
    organisation: { id: org.orgId, handle: org.handle, name: org.name },
    successor: org.successor
      ? {
          profile_id: org.successor.profileId,
          handle: org.successor.handle,
          display_name: org.successor.displayName,
          role: org.successor.role,
        }
      : null,
  });

  return (
    new Elysia({ prefix: "/account" })
      // ---------------------------------------------------------------------
      // GET /account/deletion-preview — what deleting the account would
      // leave open: each organisation a profile of it owns, who would take it
      // over, and the choices the person may make.
      // ---------------------------------------------------------------------
      .get(
        "/deletion-preview",
        async ({ headers, set, server, request }) => {
          // Per-user content — never cached or stored.
          set.headers["cache-control"] = "private, no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "account_deletion_preview",
            rl.accountDeletionStatus,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const owned = await run(
              accountErasure
                .listOwnedOrganisations(profile.accountId)
                .pipe(Effect.withSpan("account.deletion.preview")),
            );
            return { open_actions: owned.map(toOpenAction) };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            200: accountDeletionPreviewResponse,
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getAccountDeletionPreview", security: [{ bearerAuth: [] }] },
        },
      )
      // ---------------------------------------------------------------------
      // DELETE /account — Flow A: full OSN account deletion (soft delete).
      //
      // Requires: bearer access token, step-up token, body confirmation
      // (handle typed verbatim by the user), and an answer for every owned
      // organisation no other admin could take over. Returns 202 with
      // `scheduled_for`. A deletion already pending is answered first, to
      // either audience, with no confirmation or step-up.
      // ---------------------------------------------------------------------
      .delete(
        "",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "account_delete",
            rl.accountDelete,
          );
          if (rlErr) {
            set.status = 429;
            metricAccountDeletionRequested("rate_limited");
            return rlErr;
          }
          try {
            const claims = await resolveAccountWindowPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              metricAccountDeletionRequested("error");
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileByIdIncludingTombstoned(claims.profileId));
            if (!profile) {
              set.status = 401;
              metricAccountDeletionRequested("error");
              return { error: "unauthorized" };
            }

            // A retry of a deletion already requested: its handle is
            // redacted by now, and a retry needs neither the confirmation nor
            // a step-up to learn its date. Only a tombstoned account has a job
            // to read: the soft delete writes both in one batch.
            if ((profile.accountDeletedAt ?? null) !== null) {
              const pending = await run(accountErasure.getDeletionStatus(profile.accountId));
              if (pending.scheduled) {
                metricAccountDeletionRequested("already_pending");
                set.status = 202;
                return { scheduled_for: pending.scheduledFor, already_pending: true };
              }
            }
            // A pending-deletion token reaches this route only for that answer.
            if (claims.pendingDeletion) {
              set.status = 401;
              metricAccountDeletionRequested("error");
              return { error: "unauthorized" };
            }

            // Confirmation: the user must type their handle verbatim. Defends
            // against accidental clicks ("rm -rf ~ but worse").
            if (body.confirm_handle !== profile.handle) {
              set.status = 400;
              metricAccountDeletionRequested("error");
              return { error: "handle_mismatch" };
            }

            // Before the step-up token is read: one minted while the session
            // was live is not spent once it has ended. The session found here
            // is the device the soft delete keeps signed in.
            const live = await liveSession(
              "account_delete",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (live.sessionHash === null) {
              set.status = 409;
              metricAccountDeletionRequested("error");
              return live.refusal;
            }

            // The owned organisations, before the step-up token is read, so a
            // missing or refused answer spends nothing.
            const owned = await run(accountErasure.listOwnedOrganisations(profile.accountId));
            const checked = await run(
              accountErasure.checkErasureChoices(
                profile.accountId,
                owned,
                (body.choices ?? []).map((c) => ({
                  action: c.action,
                  choice: c.choice,
                  successorProfileId: c.successor_profile_id,
                })),
              ),
            );
            if (checked.kind === "invalid") {
              set.status = 400;
              metricAccountDeletionRequested("error");
              return { error: "invalid_choice", action: checked.action };
            }
            if (checked.kind === "open") {
              set.status = 409;
              metricAccountDeletionRequested("error");
              return { error: "open_actions", open_actions: checked.open.map(toOpenAction) };
            }

            const stepUpToken = body.step_up_token ?? headers["x-step-up-token"];
            if (!stepUpToken) {
              set.status = 403;
              metricAccountDeletionRequested("step_up_failed");
              return { error: "step_up_required" };
            }
            try {
              await run(auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken));
            } catch (e) {
              // A refused token asks for a fresh step-up; a database fault in
              // the verifier is the route's 500, never "step up again".
              if (!isAuthError(e)) throw e;
              set.status = 403;
              metricAccountDeletionRequested("step_up_failed");
              const { body: errBody } = handleError(e);
              return { error: "step_up_required", detail: errBody };
            }

            const result = await run(
              accountErasure.requestErasure({
                accountId: profile.accountId,
                cancel: { sessionId: live.sessionHash, familyId: live.familyId },
                heldHandleDigest: auth.heldHandleDigest,
                choices: checked.choices,
              }),
            );

            metricAccountDeletionRequested(result.newlyScheduled ? "ok" : "already_pending");

            // No fan-out here: cross-service purges only fire from
            // the sweeper AFTER the 7-day grace window elapses, so a
            // restore during the window loses nothing on Pulse / Zap.
            // See `runFanOutRetrySweep` in services/account-erasure.ts.

            set.status = 202;
            return {
              scheduled_for: result.scheduledFor,
              already_pending: !result.newlyScheduled,
            };
          } catch (e) {
            metricAccountDeletionRequested("error");
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            confirm_handle: t.String({ minLength: 1, maxLength: 64 }),
            step_up_token: t.Optional(t.String()),
            // Answers to the open actions `GET /account/deletion-preview`
            // lists, by action id. An id the account does not have is ignored.
            choices: t.Optional(
              t.Array(
                t.Object({
                  action: t.String({ maxLength: 128 }),
                  choice: t.String({ maxLength: 32 }),
                  successor_profile_id: t.Optional(t.String({ maxLength: 64 })),
                }),
                { maxItems: 200 },
              ),
            ),
          }),
          response: {
            // 202, not 200: nothing is erased yet. The account is tombstoned
            // and the hard delete becomes eligible when the grace window
            // closes at `scheduled_for`.
            202: accountDeletionScheduledResponse,
            // `handle_mismatch` — the typed confirmation did not match —
            // `invalid_choice`, plus whatever `publicError` maps a service
            // failure to.
            400: accountDeletionBadRequestResponse,
            401: errorResponse,
            // `session_stale`, or `open_actions` waiting for an answer.
            409: accountDeletionConflictResponse,
            // Missing or rejected step-up. The only status in this group that
            // carries a `detail`; see `stepUpRequiredResponse`.
            403: stepUpRequiredResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "requestAccountDeletion", security: [{ bearerAuth: [] }] },
        },
      )
      // ---------------------------------------------------------------------
      // POST /account/restore — cancellation flow during the grace window.
      //
      // The caller holds a live session of the account, either audience, and
      // a step-up token for `account_restore`, from the body's
      // `step_up_token` or the `x-step-up-token` header. With the account not
      // tombstoned it answers `cancelled: false` before asking for the
      // step-up.
      // ---------------------------------------------------------------------
      .post(
        "/restore",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "account_restore",
            rl.accountRestore,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccountWindowPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileByIdIncludingTombstoned(claims.profileId));
            // A pending-deletion token answers only while the deletion is
            // pending; after a cancel the client renews into an ordinary one.
            if (
              !profile ||
              (claims.pendingDeletion && (profile.accountDeletedAt ?? null) === null)
            ) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            // Only a live session cancels: a token whose session has ended
            // does not.
            const staleErr = await liveSessionGate(
              "account_restore",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
            }

            // Nothing pending on a live account: the soft delete writes the
            // job and the tombstone in one batch. A job gone since the read is
            // answered by `cancelErasure`.
            if ((profile.accountDeletedAt ?? null) === null) return { cancelled: false };

            const stepUpToken = body?.step_up_token ?? headers["x-step-up-token"];
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            try {
              await run(auth.verifyStepUpForAccountRestore(profile.accountId, stepUpToken));
            } catch (e) {
              set.status = 403;
              const { body: errBody } = handleError(e);
              return { error: "step_up_required", detail: errBody };
            }

            const result = await run(accountErasure.cancelErasure(profile.accountId));
            return { cancelled: result.cancelled };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Optional(t.Object({ step_up_token: t.Optional(t.String()) })),
          response: {
            // `cancelled: false` is a 200, not an error — read the flag.
            200: accountRestoreResponse,
            400: errorResponse,
            401: errorResponse,
            // Missing or rejected `account_restore` step-up.
            403: stepUpRequiredResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "restoreAccount", security: [{ bearerAuth: [] }] },
        },
      )
      // ---------------------------------------------------------------------
      // GET /account/deletion-status — UI banner support.
      // ---------------------------------------------------------------------
      .get(
        "/deletion-status",
        async ({ headers, set, server, request }) => {
          // Per-user deletion status — never cached or stored.
          set.headers["cache-control"] = "private, no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "account_deletion_status",
            rl.accountDeletionStatus,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccountWindowPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileByIdIncludingTombstoned(claims.profileId));
            // A pending-deletion token answers only while the deletion is
            // pending; after a cancel the client renews into an ordinary one.
            if (
              !profile ||
              (claims.pendingDeletion && (profile.accountDeletedAt ?? null) === null)
            ) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            // A live account has no job to read: the soft delete writes the
            // job and the tombstone in one batch.
            if ((profile.accountDeletedAt ?? null) === null) return { scheduled: false };
            return await run(accountErasure.getDeletionStatus(profile.accountId));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // Answers for a live account too — `{ scheduled: false }`, not a 404.
            // This backs a banner that is polled, so "nothing pending" has to be
            // an ordinary success.
            200: accountDeletionStatusResponse,
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getAccountDeletionStatus", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
