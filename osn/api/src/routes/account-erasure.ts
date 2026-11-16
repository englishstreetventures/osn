import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import type { DeletionPlanLine } from "@shared/email/templates";
import {
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal, resolveAccountWindowPrincipal } from "../lib/auth-derive";
import { forkBackground } from "../lib/background";
import type { CookieSessionConfig } from "../lib/cookie-session";
import { createLiveSessionCheck } from "../lib/live-session";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { metricAccountDeletionRequested, metricAuthRateLimited } from "../metrics";
import * as accountErasure from "../services/account-erasure";
import { createAuthService, type AuthConfig } from "../services/auth";
import { isAuthError } from "../services/auth/errors";
import { frontendOrigin } from "../services/auth/helpers";
import {
  DISABLED_CIRE_ORGANISER_REVOKE,
  revokeCireOrganiserSessions,
  type CireOrganiserRevokeConfig,
} from "../services/cire-organiser-revoke";
import {
  endAppSessions,
  NO_DELETION_APPS,
  previewDeletionApps,
  type AppOpenAction,
  type AppPreview,
  type DeletionAppsConfig,
} from "../services/deletion-apps";
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
  /** Per account, not per IP: `POST /account/data-link` keys it on the account id. */
  readonly accountDataLink: RateLimiterBackend;
}

/** The in-memory bundle, single process only. Budgets are in `OSN_RATE_LIMITS`. */
export function createDefaultAccountErasureRateLimiters(): AccountErasureRateLimiters {
  return {
    accountDelete: memoryLimiter(OSN_RATE_LIMITS.accountDelete),
    accountRestore: memoryLimiter(OSN_RATE_LIMITS.accountRestore),
    accountDeletionStatus: memoryLimiter(OSN_RATE_LIMITS.accountDeletionStatus),
    accountDataLink: memoryLimiter(OSN_RATE_LIMITS.accountDataLink),
  };
}

/** The app's name as people know it, for a line of the scheduled notice. */
const APP_DISPLAY_NAMES = new Map<string, string>([
  ["pulse", "Pulse"],
  ["zap", "Zap"],
  ["cire", "Cire"],
]);

/** An open action as the routes answer it, the fields the scheduled notice reads. */
interface PlannedAction {
  readonly id: string;
  readonly app: string;
  readonly label: string;
  readonly choices: ReadonlyArray<{
    readonly choice: string;
    readonly description: string;
    readonly erased_on: number | null;
  }>;
  readonly default_choice: string | null;
  readonly successor?: { readonly handle: string } | null;
  readonly candidates?: ReadonlyArray<{ readonly profile_id: string; readonly handle: string }>;
  /** Set on an organisation the account owns; its line names it by handle alone. */
  readonly organisation?: { readonly handle: string } | null;
}

/**
 * The scheduled notice's lines, from the preview this request checked and the
 * answers it stored, never from a default the server will not apply.
 *
 * Without "delete everything", each action with choices gets the description
 * of its answer, else of its default: the route has already refused an action
 * with choices, no default and no answer. A named successor is named by handle.
 * With "delete everything", nothing is stored: each app deletes what the
 * person has there as soon as it can, as the app contract says, and each
 * organisation passes to the member the preview named, or is deleted when
 * there is none. An organisation is named by its handle, never by its name,
 * which any of its admins can rewrite.
 */
export function deletionPlan(
  actions: ReadonlyArray<PlannedAction>,
  choices: accountErasure.ErasureChoices,
  deleteEverything: boolean,
): DeletionPlanLine[] {
  return actions.map((action) => {
    const label = action.organisation ? `You own @${action.organisation.handle}.` : action.label;
    if (deleteEverything) {
      if (action.app === "osn") {
        const handle = action.successor?.handle;
        return {
          label,
          outcome: handle ? `It passes to @${handle}.` : "It is deleted.",
          keptUntil: null,
        };
      }
      const app = APP_DISPLAY_NAMES.get(action.app) ?? action.app;
      return {
        label,
        outcome: `You chose to delete everything, so ${app} deletes this as soon as it can.`,
        keptUntil: null,
      };
    }
    const answer = choices[action.id];
    const chosen = answer?.choice ?? action.default_choice;
    const choice = action.choices.find((c) => c.choice === chosen);
    if (!choice) return { label, outcome: "", keptUntil: null };
    const named =
      chosen === "successor"
        ? action.candidates?.find((c) => c.profile_id === answer?.successorProfileId)?.handle
        : undefined;
    return {
      label,
      outcome: named ? `@${named} becomes the owner.` : choice.description,
      keptUntil: choice.erased_on,
    };
  });
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
  /** Where each app the deletion reaches is on this tier. */
  deletionApps: DeletionAppsConfig = NO_DELETION_APPS,
  /** The back-channel that ends the person's cire organiser sessions at the soft delete. */
  cireOrganiserRevoke: CireOrganiserRevokeConfig = DISABLED_CIRE_ORGANISER_REVOKE,
) {
  const auth = createAuthService(authConfig);
  const rl = rateLimiters;

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));
  const { liveSession, liveSessionGate } = createLiveSessionCheck({ auth, run, cookieConfig });

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  /** The app the notices send the person back to. */
  const appUrl = frontendOrigin(authConfig);

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
      | "account_deletion_preview"
      | "account_data_link",
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
  const toOpenAction = (
    org: accountErasure.OwnedOrganisation,
    candidates: ReadonlyArray<accountErasure.SuccessorCandidate>,
  ) => ({
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
      erased_on: null,
    })),
    default_choice: accountErasure.organisationDefaultChoice(org),
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
    candidates: candidates
      .filter((candidate) => candidate.orgId === org.orgId)
      .map((candidate) => ({
        profile_id: candidate.profileId,
        handle: candidate.handle,
        display_name: candidate.displayName,
        role: candidate.role,
      })),
  });

  /** An app's open action, in the route's field names. */
  const toAppOpenAction = (app: AppPreview["app"], action: AppOpenAction) => ({
    id: action.id,
    app,
    kind: action.kind,
    label: action.label,
    choices: action.choices.map((choice) => ({
      choice: choice.choice,
      description: choice.description,
      erased_on: choice.erasedOn,
    })),
    default_choice: action.defaultChoice,
    link: action.link,
  });

  /** The open actions and unreachable apps of a fresh preview, as the routes answer them. */
  const previewBody = (
    owned: ReadonlyArray<accountErasure.OwnedOrganisation>,
    apps: ReadonlyArray<AppPreview>,
    candidates: ReadonlyArray<accountErasure.SuccessorCandidate>,
  ) => ({
    open_actions: [
      ...owned.map((org) => toOpenAction(org, candidates)),
      ...apps.flatMap((preview) =>
        preview.status === "checked"
          ? preview.actions.map((action) => toAppOpenAction(preview.app, action))
          : [],
      ),
    ],
    could_not_check: apps.flatMap((preview) =>
      preview.status === "could_not_check" ? [preview.app] : [],
    ),
  });

  /**
   * The account's organisations and every app's open actions, as if the
   * deletion were requested now. The organisations are read while the
   * profile ids are read and the apps asked.
   */
  const preview = (accountId: string) =>
    Effect.all(
      [
        // The organisations, then the members a `successor` answer may name
        // in those another member could take over.
        accountErasure.listOwnedOrganisations(accountId).pipe(
          Effect.flatMap((owned) =>
            accountErasure
              .listSuccessorCandidates(
                accountId,
                owned.flatMap((org) => (org.successor === null ? [] : [org.orgId])),
              )
              .pipe(Effect.map((candidates) => ({ owned, candidates }))),
          ),
        ),
        accountErasure.profileIdsOf(accountId).pipe(
          Effect.flatMap((profileIds) =>
            previewDeletionApps(deletionApps, {
              profileIds,
              deletesAt: Math.floor(Date.now() / 1_000) + accountErasure.DELETION_WINDOW_SECONDS,
            }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.withSpan("account.deletion.preview"));

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
            const [{ owned, candidates }, apps] = await run(preview(profile.accountId));
            return previewBody(owned, apps, candidates);
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

            // Either answers or "delete everything", never both: refused
            // before any app is asked anything.
            const deleteEverything = body.delete_everything === true;
            if (deleteEverything && (body.choices ?? []).length > 0) {
              set.status = 400;
              metricAccountDeletionRequested("error");
              return { error: "choices_with_delete_everything" };
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

            // A fresh preview of the organisations and every app, before the
            // step-up token is read, so a refusal here spends nothing. An app
            // that cannot be asked holds the deletion until it answers.
            const [{ owned, candidates }, apps] = await run(preview(profile.accountId));
            const fresh = previewBody(owned, apps, candidates);
            if (fresh.could_not_check.length > 0) {
              set.status = 409;
              metricAccountDeletionRequested("could_not_check");
              return { error: "could_not_check", ...fresh };
            }

            // With "delete everything" nothing is stored: each app erases the
            // person's data soonest, and each organisation passes to a
            // successor where one exists.
            let choices: accountErasure.ErasureChoices = {};
            if (!deleteEverything) {
              const checked = await run(
                accountErasure.checkErasureChoices(
                  profile.accountId,
                  owned,
                  apps,
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
              if (checked.kind === "stale") {
                set.status = 409;
                metricAccountDeletionRequested("stale_choices");
                return { error: "stale_choices", ...fresh };
              }
              if (checked.kind === "open") {
                set.status = 409;
                metricAccountDeletionRequested("error");
                return {
                  error: "open_actions",
                  open_actions: [
                    ...checked.organisations.map((org) => toOpenAction(org, candidates)),
                    ...checked.appActions.map(({ app, action }) => toAppOpenAction(app, action)),
                  ],
                };
              }
              choices = checked.choices;
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
                choices,
                deleteEverything,
              }),
            );

            metricAccountDeletionRequested(result.newlyScheduled ? "ok" : "already_pending");

            // No erasure in any app here: that waits for the window to pass
            // (`runFanOutRetrySweep`), so a cancel loses nothing. The
            // person's own sessions in an app that keeps them end now, in the
            // background; the app's erasure deletes any that survive. cire's
            // organiser sessions end through the revoke osn-api already uses
            // for sign out everywhere else, while the profiles still exist.
            if (result.newlyScheduled) {
              // The scheduled notice: the date, how to keep the account, and
              // what each answer does, as this request's own preview said.
              await run(
                forkBackground(
                  auth.notifySecurityEventByAccountId(
                    profile.accountId,
                    "account_deletion_scheduled",
                    "account-deletion-scheduled",
                    {
                      deletesAt: result.scheduledFor,
                      appUrl,
                      deleteEverything,
                      plan: deletionPlan(fresh.open_actions, choices, deleteEverything),
                    },
                  ),
                ),
              );
              await run(forkBackground(endAppSessions(deletionApps, result.profileIds)));
              await run(
                forkBackground(
                  revokeCireOrganiserSessions(
                    cireOrganiserRevoke,
                    profile.accountId,
                    "account_deletion",
                  ),
                ),
              );
            }

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
            // Delete everything: every app erases the person's data soonest,
            // and each organisation passes to a successor where one exists.
            // Refused together with `choices`.
            delete_everything: t.Optional(t.Boolean()),
            // Answers to the open actions `GET /account/deletion-preview`
            // lists, by action id. An organisation id the account does not
            // have is ignored; an app action the fresh preview does not list
            // is refused (409 `stale_choices`).
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
            // `invalid_choice`, `choices_with_delete_everything`, plus
            // whatever `publicError` maps a service failure to.
            400: accountDeletionBadRequestResponse,
            401: errorResponse,
            // `session_stale`; `could_not_check` while an app cannot be asked;
            // `stale_choices` when an answer names an app action the fresh
            // preview does not list; `open_actions` waiting for an answer.
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
              // A refused token asks for a fresh step-up; a database fault in the
              // verifier is the route's 500, never "step up again".
              if (!isAuthError(e)) throw e;
              set.status = 403;
              const { body: errBody } = handleError(e);
              return { error: "step_up_required", detail: errBody };
            }

            const result = await run(accountErasure.cancelErasure(profile.accountId));
            if (result.cancelled) {
              await run(
                forkBackground(
                  auth.notifySecurityEventByAccountId(
                    profile.accountId,
                    "account_deletion_cancelled",
                    "account-deletion-cancelled",
                    { appUrl },
                  ),
                ),
              );
            }
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
      // POST /account/data-link — "send me a link": an email to the account's
      // own address with a link to the page that downloads its data. The
      // email holds no data and the link no token: the page asks the reader
      // to sign in and step up, as a download from Settings does.
      // ---------------------------------------------------------------------
      .post(
        "/data-link",
        async ({ headers, set, server, request }) => {
          // Per IP first, so a caller with no token makes the server verify
          // nothing and read nothing.
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "account_data_link",
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
            const staleErr = await liveSessionGate(
              "account_data_link",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
            }
            // Per account, so rotating addresses cannot fill one mailbox.
            let allowed: boolean;
            try {
              allowed = await rl.accountDataLink.check(profile.accountId);
            } catch {
              allowed = false;
            }
            if (!allowed) {
              metricAuthRateLimited("account_data_link");
              set.status = 429;
              return { error: "rate_limited" };
            }
            await run(
              forkBackground(
                Effect.gen(function* () {
                  const email = yield* EmailService;
                  yield* email.send({
                    template: "account-data-link",
                    to: profile.email,
                    data: {
                      instanceName: authConfig.instanceName,
                      url: `${appUrl}/settings#account`,
                    },
                  });
                }).pipe(
                  Effect.catch(() =>
                    Effect.logWarning("account data link not sent", {
                      template: "account-data-link",
                    }),
                  ),
                ),
              ),
            );
            set.status = 202;
            return { sent: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // Sent in the background: 202 says it was asked for, not delivered.
            202: t.Object({ sent: t.Literal(true) }),
            400: errorResponse,
            401: errorResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "sendAccountDataLink", security: [{ bearerAuth: [] }] },
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
