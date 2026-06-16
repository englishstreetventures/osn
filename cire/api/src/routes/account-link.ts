import type { RateLimiterBackend } from "@shared/rate-limit";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
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
import { LinkAccountBody } from "../schemas/account-link";
import { accountLinkService } from "../services/account-link";
import type { OsnAccountResolver } from "../services/osn-bridge";

const PREFIX = "/api/account/link";

/** Transport failure resolving the OSN account id over ARC (osn-api down / 5xx). */
class OsnAccountLookupError extends Data.TaggedError("OsnAccountLookupError")<{
  reason: string;
}> {}

/**
 * Guest-only account-link routes (GET status + DELETE unlink). Gated by the
 * guest session cookie alone — an invitee reads/removes their own household's
 * links without needing a live OSN token. The POST link lives in a separate
 * instance ({@link createAccountLinkPostRoute}) because it additionally
 * requires an OSN token; keeping them apart is what method-gates `osnAuth` to
 * POST (the same sibling-instance pattern rsvp + organiser routes use).
 *
 * Both instances share a per-IP `limiter` (S-L1) so a session can't drive
 * unbounded membership probes / unlink churn.
 */
export const createAccountLinkRoutes = (db: Db, limiter: RateLimiterBackend) =>
  new Elysia({ prefix: PREFIX })
    .use(rateLimitMiddleware(limiter))
    .use(sessionAuth(db))
    // GET /api/account/link — link status for every invitee in the household.
    // Returns presence + linked-at; never the OSN account id (S2S-only) nor the
    // profile id (kept minimal).
    .get("/", ({ familyId, set }) => {
      // sessionAuth guarantees this; the guard is a runtime safety net.
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      return runCire(
        accountLinkService.listByFamily(familyId).pipe(
          Effect.provideService(DbService, db),
          Effect.map((links) => ({
            links: links.map((l) => ({ guestId: l.guestId, linkedAt: l.linkedAt.getTime() })),
          })),
        ),
      );
    })
    // DELETE /api/account/link/:guestId — remove an invitee's link, scoped to
    // the caller's household. Idempotent.
    .delete("/:guestId", ({ familyId, params, set }) => {
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const guestId = params.guestId;
      return runCire(
        accountLinkService.unlink({ familyId, guestId }).pipe(
          Effect.provideService(DbService, db),
          Effect.tap(() => Effect.sync(() => metricAccountLinkUnlink("ok"))),
          Effect.as({ linked: false, guestId }),
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
 * POST /api/account/link — attach an invitee to the caller's OSN account.
 *
 * The one deliberate dual-credential route: the guest session cookie (derives
 * `familyId`) proves the household; the OSN access token (derives
 * `osnProfileId`) proves the OSN identity. Both `sessionAuth` and `osnAuth`
 * gate this instance, so the OSN gate applies to POST only — GET/DELETE live in
 * the sibling instance above. The profile is resolved to its account id S2S
 * over ARC so account-level linking lets any of the user's OSN profiles later
 * see the invitation in Pulse; the account id is never returned to the client.
 */
export const createAccountLinkPostRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnAccountId?: OsnAccountResolver,
) =>
  new Elysia({ prefix: PREFIX })
    // Rate limit runs in onBeforeHandle (before the handler), so it gates the
    // ARC-sign + S2S amplifier and the family-membership oracle even though the
    // auth derives run first (S-L1).
    .use(rateLimitMiddleware(limiter))
    .use(sessionAuth(db))
    .use(osnAuth(osnAuthOptions))
    .post(
      "/",
      async ({ request, familyId, osnProfileId, set }) => {
        // Both plugins gate this route; the guards are runtime safety nets.
        if (!familyId || !osnProfileId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        if (!resolveOsnAccountId) {
          // Deployment has no ARC key configured — linking is disabled, not broken.
          metricAccountLinkRequest("disabled");
          set.status = 503;
          return { error: "Account linking is not available" };
        }
        const resolveAccount = resolveOsnAccountId;
        const profileId = osnProfileId;

        const raw: unknown = await request.json().catch(() => null);

        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknown(LinkAccountBody)(raw);

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
              guestId: body.guestId,
              osnAccountId: resolution.accountId,
              osnProfileId: profileId,
            });
            yield* Effect.sync(() => metricAccountLinkRequest("ok"));
            set.status = 201;
            return { linked: true, guestId: link.guestId };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTags({
              ParseError: () =>
                Effect.sync(() => {
                  metricAccountLinkRequest("error");
                  set.status = 400;
                  return { error: "Missing or invalid fields" };
                }),
              GuestNotInFamily: () =>
                Effect.sync(() => {
                  metricAccountLinkRequest("error");
                  set.status = 403;
                  return { error: "Guest does not belong to this family" };
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
      // Sentinel parse hook: stops Elysia consuming the body so the handler
      // parses it by hand — malformed JSON degrades to the schema's 400.
      { parse: () => ({}) },
    );
