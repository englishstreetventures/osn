import type { FeatureFlags } from "@shared/feature-flags";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Data, Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { ACCOUNT_LINKING_FLAG } from "../lib/account-linking";
import { buildSessionCookie, parseOrganiserSessionToken, parseSessionToken } from "../lib/cookie";
import {
  measureAccountLinkResolve,
  metricAccountLinkRequest,
  metricAccountLinkUnlink,
} from "../metrics";
import { sessionAuth } from "../middleware/auth";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { accountLinkService } from "../services/account-link";
import type { OsnAccountResolver } from "../services/osn-bridge";
import { sessionService } from "../services/session";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const PREFIX = "/api/account/link";

/** Transport failure resolving the OSN account id over ARC (osn-api down / 5xx). */
class OsnAccountLookupError extends Data.TaggedError("OsnAccountLookupError")<{
  reason: string;
}> {}

/**
 * The guest-only account-link route (DELETE unlink). Gated by the guest session
 * cookie alone — an invitee removes their own household's links without
 * needing a live OSN token. The household's link state is not read here: the
 * claim and restore responses carry it (`accountLink`), so the guest site
 * draws the account-link box without a request of its own. The POST link
 * lives in a separate instance ({@link createAccountLinkPostRoute}) because it
 * additionally requires an OSN token; keeping them apart is what method-gates
 * `osnAuth` to POST (the same sibling-instance pattern rsvp + organiser routes
 * use).
 *
 * Both instances share a per-IP `limiter` so a session can't drive unbounded
 * membership probes or unlink churn.
 */
export const createAccountLinkRoutes = (
  db: Db,
  limiter: RateLimiterBackend,
  resolveOsnAccountId?: OsnAccountResolver,
) =>
  new Elysia({ prefix: PREFIX })
    .use(rateLimitMiddleware(limiter))
    .use(sessionAuth(db))
    // DELETE /api/account/link/:guestId — remove a link. Only the account a
    // seat is bound to may release it: the seat must be the member this
    // session chose, and a live link must match this browser's musubi
    // sign-in. Otherwise anyone holding the household code could unlink a
    // member and relink the seat to their own account, which would make
    // `rsvps.submitted_via_link` claim "signed in as" for the wrong person.
    // Idempotent: a seat with no link answers 200.
    .delete("/:guestId", ({ familyId, memberGuestId, params, request, set }) => {
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const guestId = params.guestId;
      if (guestId !== memberGuestId) {
        metricAccountLinkUnlink("error");
        set.status = 403;
        return { error: "not_your_seat" };
      }
      return runCire(
        Effect.gen(function* () {
          const { result } = yield* accountLinkService.memberMatch(
            guestId,
            parseOrganiserSessionToken(request.headers.get("cookie")),
            resolveOsnAccountId,
          );
          if (result !== "match" && result !== "unlinked") {
            yield* Effect.sync(() => metricAccountLinkUnlink("error"));
            set.status = 403;
            return { error: "not_linked_account" };
          }
          yield* accountLinkService.unlink({ familyId, guestId });
          yield* Effect.sync(() => metricAccountLinkUnlink("ok"));
          return { linked: false, guestId };
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("AccountLinkWriteError", () =>
            Effect.sync(() => {
              metricAccountLinkUnlink("error");
              set.status = 500;
              return { error: "Could not unlink account" };
            }),
          ),
        ),
      );
    });

/**
 * POST /api/account/link — attach the session's household member to the
 * caller's OSN account. No body: the member is the one this session chose
 * (`POST /api/claim/member`, or the server's choice for a one-member
 * household); with none chosen it answers 409 `member_required`.
 *
 * The one deliberate dual-credential route: the guest session cookie (derives
 * `familyId`) proves the household; the OSN access token (derives
 * `osnProfileId`) proves the OSN identity. Both `sessionAuth` and `osnAuth`
 * gate this instance, so the OSN gate applies to POST only — DELETE lives in
 * the sibling instance above. A seat in the organiser's host-preview family is
 * never linkable (403, like a seat from another household). The profile is resolved to its account id S2S
 * over ARC so account-level linking lets any of the user's OSN profiles later
 * see the invitation in Pulse; the account id is never returned to the client.
 */
export const createAccountLinkPostRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  flags: FeatureFlags,
  resolveOsnAccountId?: OsnAccountResolver,
  webOrigin = "http://localhost:4321",
) =>
  new Elysia({ prefix: PREFIX })
    // The limiter answers before the guest session lookup (a before-handle
    // resolve, mounted after it) and before the handler, so it gates the D1
    // read, the ARC-sign + S2S amplifier and the family-membership oracle.
    // `osnAuth` still resolves its credential in the transform phase, ahead of
    // the limiter.
    .use(rateLimitMiddleware(limiter))
    .use(sessionAuth(db))
    .use(osnAuth(osnAuthOptions))
    .post(
      "/",
      async ({ request, familyId, memberGuestId, osnProfileId, set }) => {
        // Both plugins gate this route; the guards are runtime safety nets.
        if (!familyId || !osnProfileId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        // Feature gate (defense in depth): even though the UI is hidden when the
        // flag is off, reject a hand-crafted POST so linking can't be driven
        // while the feature is disabled. Same 503 "disabled" contract as the
        // no-ARC-key branch below.
        // No `waitUntil`: this is the enforcement check, so a stale payload is
        // refreshed in line rather than served, and turning the flag off stops
        // links within the cache TTL.
        const linking = await flags.forRequest({ id: familyId });
        if (!linking.isOn(ACCOUNT_LINKING_FLAG)) {
          metricAccountLinkRequest("disabled");
          set.status = 503;
          return { error: "Account linking is not available" };
        }
        if (!resolveOsnAccountId) {
          // Deployment has no ARC key configured — linking is disabled, not broken.
          metricAccountLinkRequest("disabled");
          set.status = 503;
          return { error: "Account linking is not available" };
        }
        // The link binds the member this session chose ("Who are you?"),
        // never a seat named in the request.
        if (memberGuestId === null) {
          metricAccountLinkRequest("error");
          set.status = 409;
          return { error: "member_required" };
        }
        const guestId = memberGuestId;
        const resolveAccount = resolveOsnAccountId;
        const profileId = osnProfileId;

        return runCire(
          Effect.gen(function* () {
            const resolution = yield* Effect.tryPromise({
              try: () => resolveAccount(profileId),
              catch: (cause) => new OsnAccountLookupError({ reason: String(cause) }),
            }).pipe(measureAccountLinkResolve);
            if (!resolution.ok) {
              // Token verified but the profile no longer exists in OSN (deleted
              // between issuance and now). Rare; distinct from a transport failure.
              yield* Effect.sync(() => metricAccountLinkRequest("profile_not_found"));
              set.status = 404;
              return { error: "OSN profile not found" };
            }

            const link = yield* accountLinkService.link({
              familyId,
              guestId,
              osnAccountId: resolution.accountId,
              osnProfileId: profileId,
            });

            // Rotate the guest session on a successful link — session-fixation
            // defence. The link is a privilege change (the household is now bound
            // to an OSN account), so any pre-existing token (possibly attacker-
            // planted before the legitimate user linked) is revoked and a fresh
            // cookie is issued, atomically. Best-effort: if rotation fails the
            // link still stands and we keep the existing session (logged inside
            // the service) rather than 500-ing a completed link.
            const oldToken = parseSessionToken(request.headers.get("cookie"));
            if (oldToken) {
              const rotated = yield* sessionService
                .rotate(familyId, oldToken, SESSION_TTL_SECONDS)
                .pipe(Effect.catchTag("SessionWriteError", () => Effect.succeed(undefined)));
              if (rotated) {
                set.headers["set-cookie"] = buildSessionCookie(rotated.token, {
                  secure: webOrigin.startsWith("https://"),
                  maxAgeSeconds: SESSION_TTL_SECONDS,
                });
              }
            }

            yield* Effect.sync(() => metricAccountLinkRequest("ok"));
            set.status = 201;
            return { linked: true, guestId: link.guestId };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTags({
              GuestNotInFamily: () =>
                Effect.sync(() => {
                  metricAccountLinkRequest("error");
                  set.status = 403;
                  return { error: "Guest does not belong to this family" };
                }),
              PlusOneSeatNotLinkable: () =>
                Effect.sync(() => {
                  metricAccountLinkRequest("error");
                  set.status = 403;
                  return { error: "plus_one_seat" };
                }),
              AccountLinkConflict: () =>
                Effect.sync(() => {
                  metricAccountLinkRequest("already_linked");
                  set.status = 409;
                  return { error: "already_linked" };
                }),
              OsnAccountLookupError: (err) =>
                Effect.logError("osn account lookup failed", { reason: err.reason }).pipe(
                  Effect.flatMap(() =>
                    Effect.sync(() => {
                      metricAccountLinkRequest("osn_unavailable");
                      set.status = 502;
                      return { error: "OSN account lookup failed" };
                    }),
                  ),
                ),
              AccountLinkWriteError: () =>
                Effect.sync(() => {
                  metricAccountLinkRequest("error");
                  set.status = 500;
                  return { error: "Could not link account" };
                }),
            }),
          ),
        );
      },
      // The request has no body to read; the hook keeps Elysia from parsing
      // whatever a caller sends.
      { parse: () => ({}) },
    );
