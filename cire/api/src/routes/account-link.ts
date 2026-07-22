import type { FeatureFlags } from "@shared/feature-flags";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { buildSessionCookie, parseSessionToken } from "../lib/cookie";
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
import { sessionService } from "../services/session";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const PREFIX = "/api/account/link";

/**
 * Feature flag gating the whole OSN ("Pulse") account-linking surface. OFF ⇒
 * both the GET status probe and the POST link answer 503 ("disabled"); the
 * guest UI reads the 503 GET as "disabled" and hides the section. Default is OFF
 * (see the `FLAGS` registry), so linking stays hidden until it's turned on in
 * the GrowthBook dashboard — independent of whether the ARC linking keys exist.
 */
const LINKING_FLAG = "cire.account-linking" as const;

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
export const createAccountLinkRoutes = (db: Db, limiter: RateLimiterBackend, flags: FeatureFlags) =>
  new Elysia({ prefix: PREFIX })
    .use(rateLimitMiddleware(limiter))
    .use(sessionAuth(db))
    // GET /api/account/link — link status for every invitee in the household.
    // Returns presence + linked-at; never the OSN account id (S2S-only) nor the
    // profile id (kept minimal).
    .get("/", async ({ familyId, set }) => {
      // sessionAuth guarantees this; the guard is a runtime safety net.
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      // Feature gate: the account-linking flag hides this surface. A 503 here is
      // read by the guest UI as "disabled" ⇒ the whole "Link your Pulse account"
      // section renders nothing. Bucketed by household so a future percentage
      // rollout is stable per family.
      const linking = await flags.forRequest({ id: familyId });
      if (!linking.isOn(LINKING_FLAG)) {
        set.status = 503;
        return { error: "Account linking is not available" };
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
  flags: FeatureFlags,
  resolveOsnAccountId?: OsnAccountResolver,
  webOrigin = "http://localhost:4321",
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
        // Feature gate (defense in depth): even though the UI is hidden when the
        // flag is off, reject a hand-crafted POST so linking can't be driven
        // while the feature is disabled. Same 503 "disabled" contract as the
        // no-ARC-key branch below.
        const linking = await flags.forRequest({ id: familyId });
        if (!linking.isOn(LINKING_FLAG)) {
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

            // C6: rotate the guest session on a successful link — session-fixation
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
