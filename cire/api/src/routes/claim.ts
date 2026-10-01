import { families, guests } from "@cire/db";
import type { RateLimiterBackend } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { and, eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { type AccountLinking, isAccountLinkingOn } from "../lib/account-linking";
import {
  buildSessionCookie,
  clearSessionCookie,
  parseOrganiserSessionToken,
  parseSessionToken,
} from "../lib/cookie";
import { getWaitUntil } from "../lib/execution-ctx";
import { metricHouseholdMemberChosen, metricHouseholdMemberCleared } from "../metrics";
import { sessionAuth } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { turnstileGate } from "../middleware/turnstile";
import { runCire } from "../observability";
import { ChooseMemberBody, ClaimBody } from "../schemas/claim";
import { accountLinkService } from "../services/account-link";
import { type AccountLinkGate, claimService } from "../services/claim";
import { inviteService } from "../services/invite";
import { sessionService } from "../services/session";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The account-link half of a claim payload, taken from this request: whether
 * linking is offered to the household, and the OSN sign-in cookie whose
 * liveness the payload reports. Both cookies ride the one credentialed
 * request the page already makes, so the guest site learns everything its
 * account-link box needs without a request of its own.
 *
 * The request's `waitUntil` goes to the flag provider, which then answers
 * from a stale cached payload at once and refreshes it in the background, so
 * only a cold isolate waits on GrowthBook. The check itself is handed to the
 * same `waitUntil`: the payload stops waiting for it after
 * `ACCOUNT_LINK_FLAG_WAIT`, but a cold-isolate refresh it started is shared
 * with every later request in the isolate, and Workers cancels a finished
 * request's outstanding I/O unless `waitUntil` holds it. Held, the refresh
 * settles (the provider bounds it at 5 s) and serves the requests after it.
 * The check never rejects, so holding it cannot fail.
 */
function accountLinkGate(
  linking: AccountLinking,
  request: Request,
  memberGuestId: string | null,
): AccountLinkGate {
  const waitUntil = getWaitUntil(request);
  return {
    enabledFor: (familyId) => {
      const answer = isAccountLinkingOn(linking, familyId, waitUntil);
      waitUntil?.(answer);
      return answer;
    },
    osnSessionToken: parseOrganiserSessionToken(request.headers.get("cookie")),
    memberGuestId,
    resolveAccountId: linking.resolveAccountId,
    avatarOrigins: linking.avatarOrigins,
  };
}

export interface ClaimRouteOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin: string;
  /** Per-IP rate limiter (brute-force protection). */
  limiter: RateLimiterBackend;
  /**
   * Turnstile verifier (KEY-OPTIONAL). `null` ⇒ gate skipped; configured ⇒
   * a missing/invalid token fails closed (403) before the credential lookup.
   */
  turnstileVerifier?: TurnstileVerifier | null;
  /** Decides the account-link state the payload carries. */
  accountLinking: AccountLinking;
}

export const createClaimRoutes = (
  db: Db,
  { webOrigin, limiter, turnstileVerifier = null, accountLinking }: ClaimRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" }).use(rateLimitMiddleware(limiter)).post(
    "/",
    async ({ request, set }) => {
      // The same payload the restore serves, under the same cache rules: it is
      // the household's invite, and its `accountLink.signedIn` depends on a
      // second cookie. Set first, so every outcome carries it.
      set.headers["cache-control"] = "no-store";
      set.headers.vary = "Origin, Cookie";

      const raw: unknown = await request.json().catch(() => null);

      // Turnstile bot gate (key-optional; no-op when unconfigured). Runs after
      // the per-IP limiter, before the credential lookup — a bot that can't pass
      // the challenge never reaches the claim-code oracle.
      const tsErr = await turnstileGate(turnstileVerifier, "claim", raw, request.headers);
      if (tsErr) {
        set.status = tsErr.status;
        return { error: tsErr.error };
      }

      return runCire(
        Effect.gen(function* () {
          const { publicId } = yield* Schema.decodeUnknownEffect(ClaimBody)(raw);
          const result = yield* claimService.lookup(
            publicId.trim().toUpperCase(),
            accountLinkGate(accountLinking, request, null),
          );
          // A fresh claim chooses no member, so a member in the payload is the
          // one the server chose for a one-member household. The new session
          // starts with it.
          const member = result.member?.guestId ?? null;
          // Session write may fail (DB transient error) — we still hand the user
          // their invite payload and skip Set-Cookie. Error is logged inside the
          // service. They can re-login to mint a fresh session.
          const session: { token: string; expiresAt: Date } | undefined = yield* sessionService
            .create(result.familyId, SESSION_TTL_SECONDS, member)
            .pipe(Effect.catchTag("SessionWriteError", () => Effect.succeed(undefined)));
          if (session && member !== null) {
            yield* Effect.sync(() => metricHouseholdMemberChosen("auto_single"));
          }
          if (session) {
            set.headers["set-cookie"] = buildSessionCookie(session.token, {
              secure: webOrigin.startsWith("https://"),
              maxAgeSeconds: SESSION_TTL_SECONDS,
            });
          }
          return result;
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("SchemaError", () =>
            Effect.sync(() => {
              set.status = 400;
              return { error: "Missing or invalid fields" };
            }),
          ),
          Effect.catchTag("InvalidCredentials", () =>
            Effect.sync(() => {
              set.status = 401;
              return { error: "Invalid credentials" };
            }),
          ),
        ),
      );
    },
    // Sentinel parse hook: stops Elysia from consuming the body so the handler
    // can parse it by hand — a malformed payload degrades to the schema's 400
    // instead of Elysia's parser error.
    { parse: () => ({}) },
  );

export interface ClaimSignoutRouteOptions {
  /** Primary origin (used for the cleared cookie's `secure` flag). */
  webOrigin: string;
  /** Per-IP limiter. Shares the restore route's page-load-sized budget. */
  limiter: RateLimiterBackend;
}

/**
 * `POST /api/claim/signout` — end the household session this browser holds.
 *
 * The guest counterpart to the organiser's `POST /api/auth/signout`, and the
 * server half of the guest site's "Not the <name> family? Sign out" control.
 * Until this existed there was NO way for a guest to end a `cire_session`:
 * `sessionService.revoke` had no guest-facing caller, so a 30-day credential
 * that auto-exercises on every page load could only be ended by expiry or an
 * organiser action (deactivate / remint). Shared and borrowed devices are the
 * normal case for a wedding invite — a family tablet, a phone handed to a
 * relative, a venue kiosk — and on those the surviving cookie is a live *write*
 * capability: it reads guest names and per-event dietary free text (Art. 9) and
 * it can submit or overwrite the household's RSVPs.
 *
 * A THIRD sibling instance rather than another route on `createClaimSessionRoutes`,
 * because it deliberately does NOT mount `sessionAuth`. Signing out is
 * idempotent and inherently safe: the only thing a caller can revoke is a token
 * they already present, so there is nothing to authorise. Requiring auth would
 * make the one case that most needs to succeed — an expired or already-revoked
 * cookie still sitting in the browser — answer 401 and leave the cookie in
 * place. This always clears it and always answers 204.
 *
 * The revoke is best-effort: a D1 blip must not leave the guest believing they
 * are still signed in, and the cleared cookie already makes the token
 * unreachable from this browser. `POST`, so `originGuard` covers it.
 */
export const createClaimSignoutRoutes = (
  db: Db,
  { webOrigin, limiter }: ClaimSignoutRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" })
    .use(rateLimitMiddleware(limiter))
    .post("/signout", async ({ request, set }) => {
      const token = parseSessionToken(request.headers.get("cookie"));

      // Clear unconditionally, and BEFORE the revoke can fail. This is the half
      // that always works and the half the guest can see.
      set.headers["set-cookie"] = clearSessionCookie({
        secure: webOrigin.startsWith("https://"),
      });
      set.headers["cache-control"] = "no-store";

      if (token) {
        await runCire(
          sessionService.revoke(token).pipe(
            Effect.provideService(DbService, db),
            // Already logged inside the service. Swallowed on purpose: the
            // cookie is gone either way, and reporting a failure here would
            // tell the guest they are still signed in when this browser can no
            // longer present the token.
            Effect.catchTag("SessionWriteError", () => Effect.void),
          ),
        );
      }

      set.status = 204;
      return null;
    });

/** The session is valid, but belongs to a different wedding than the one asked for. */
class SessionNotForWedding extends Data.TaggedError("SessionNotForWedding") {}

export interface ClaimSessionRouteOptions {
  /** Primary origin (used for the cleared cookie's `secure` flag). */
  webOrigin: string;
  /**
   * Per-IP limiter for the restore read. Deliberately NOT the claim limiter:
   * that one is a 5/min brute-force budget sized for a credential surface, and
   * this route is hit on every page load by guests who already hold a session —
   * a household behind one NAT would 429 itself just by reloading. See the
   * sibling-instance split below.
   */
  limiter: RateLimiterBackend;
  /** Decides the account-link state the payload carries. */
  accountLinking: AccountLinking;
}

/**
 * `GET /api/claim/session` — re-read the invite for the household this
 * `cire_session` cookie already belongs to.
 *
 * A SIBLING instance to `createClaimRoutes` rather than another route on it, so
 * the two get different limiters (Elysia applies a scoped middleware per
 * instance) — the same split as the organiser hosts read/write routes. The
 * credential surface keeps its tight budget; the restore read gets a page-load-
 * sized one.
 *
 * No Turnstile: the caller isn't presenting a code, they're presenting a session
 * this API minted. No Origin guard concerns either — it is a safe GET.
 *
 * Two different 401s, and the difference matters. A DEAD session (family
 * withdrawn, or its row gone) gets its cookie cleared, so the household lands
 * on the code form instead of retrying a dead cookie forever. A session that is
 * merely for ANOTHER WEDDING keeps its cookie — it is a perfectly good session,
 * and clearing it would sign a guest out of their own invite just because they
 * opened someone else's link. Both answer the same generic body, so the
 * endpoint still discloses nothing beyond "not your invite".
 */
export const createClaimSessionRoutes = (
  db: Db,
  { webOrigin, limiter, accountLinking }: ClaimSessionRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" })
    .use(rateLimitMiddleware(limiter))
    // Cache directives, set BEFORE `sessionAuth` so they land on every outcome —
    // including the 401 that plugin short-circuits with, which never reaches the
    // handler below. The 200 body is selected ENTIRELY by the cookie and carries
    // guest names, per-event dietary free text (Art. 9) and the closing
    // note: `no-store` keeps it out of every cache — browser,
    // intermediary and CDN — whatever a future Cloudflare page rule says, and
    // `Vary: Cookie` is the backstop for a cache that ignores `no-store`, making
    // the cookie part of the key so one household's invite can never be replayed
    // to another.
    .onBeforeHandle({ as: "scoped" }, ({ set }) => {
      set.headers["cache-control"] = "no-store";
      set.headers.vary = "Origin, Cookie";
    })
    .use(sessionAuth(db))
    .get("/session", async ({ familyId, memberGuestId, set, query, request }) => {
      // sessionAuth's onBeforeHandle guarantees this; the guard is a runtime
      // safety net (and narrows the type).
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      // The restore MUST name the wedding it is restoring into. The guest site
      // serves every wedding from one origin (`/<slug>`), while `cire_session`
      // names exactly one family — hence one wedding. Without this, a guest
      // holding wedding A's session who opens wedding B's link would have A's
      // events and members painted silently into B's shell, and an RSVP sent
      // from that state writes to A's events while they believe they answered
      // B's. Required, not optional: an unscoped restore has no correct answer.
      const slug = typeof query.slug === "string" ? query.slug : "";
      if (!slug) {
        set.status = 400;
        return { error: "Missing slug" };
      }

      return runCire(
        Effect.gen(function* () {
          // Same generic failure as every other refusal here, so the endpoint
          // still discloses nothing beyond "not your invite".
          const ownsWedding = yield* inviteService.sessionOwnsWedding(familyId, slug);
          if (!ownsWedding) return yield* Effect.fail(new SessionNotForWedding());
          const result = yield* claimService.restore(
            familyId,
            accountLinkGate(accountLinking, request, memberGuestId),
          );
          // The session had no member and the payload names one: the server
          // chose for a one-member household, so the session keeps it. Best
          // effort — the next restore chooses again if this write fails.
          const chosen = result.member?.guestId ?? null;
          const token = parseSessionToken(request.headers.get("cookie"));
          if (memberGuestId === null && chosen !== null && token) {
            yield* sessionService.setMember(token, familyId, chosen).pipe(
              Effect.tap(() => Effect.sync(() => metricHouseholdMemberChosen("auto_single"))),
              Effect.catchTag("SessionWriteError", () => Effect.void),
            );
          }
          return result;
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("InvalidCredentials", () =>
            Effect.sync(() => {
              set.status = 401;
              // The session is genuinely dead (family withdrawn or gone), so
              // drop the cookie rather than leave the household retrying it.
              set.headers["set-cookie"] = clearSessionCookie({
                secure: webOrigin.startsWith("https://"),
              });
              return { error: "Invalid credentials" };
            }),
          ),
          Effect.catchTag("SessionNotForWedding", () =>
            Effect.sync(() => {
              set.status = 401;
              // Deliberately NO cookie clear: the session is perfectly valid,
              // just for a different wedding. Clearing it here would sign a
              // guest out of their own invite because they opened someone
              // else's link.
              return { error: "Invalid credentials" };
            }),
          ),
        ),
      );
    });

export interface ClaimMemberRouteOptions {
  /** Per-IP limiter. Shares the restore route's page-load-sized budget. */
  limiter: RateLimiterBackend;
  /** Decides whether the member step is on for the household. */
  accountLinking: AccountLinking;
}

/** The guest named is not a member of the session's household. */
class NotHouseholdMember extends Data.TaggedError("NotHouseholdMember") {}
/** The guest named is a plus-one, whose row another guest typed in. */
class PlusOneSeat extends Data.TaggedError("PlusOneSeat") {}

/**
 * `POST` / `DELETE /api/claim/member` — "Who are you?".
 *
 * A claim code proves a household, not a person. `POST { guestId }` records
 * which member this browser's session says it is; replies and the musubi link
 * then hang off that choice. `DELETE` is the "Not you?" control: it clears the
 * choice and keeps the household claimed.
 *
 * The choice is the guest's word, backed only by the household's code — the
 * household trust model the claim has always had. Only a member of the
 * session's own household may be named, and never a plus-one.
 *
 * `POST` checks the flag with the enforcing (uncached) read, as the link POST
 * does: a household the step is off for gets 404. It answers 200 with the
 * member and the household's account-link state for that member, since only
 * the server can tell whether this browser's sign-in is the account the member
 * is linked to. `DELETE` is idempotent and always 204. Both are behind
 * `originGuard` (mounted after it in `app.ts`).
 */
export const createClaimMemberRoutes = (
  db: Db,
  { limiter, accountLinking }: ClaimMemberRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" })
    .use(rateLimitMiddleware(limiter))
    .onBeforeHandle({ as: "scoped" }, ({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .use(sessionAuth(db))
    .post(
      "/member",
      async ({ familyId, request, set }) => {
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        const token = parseSessionToken(request.headers.get("cookie"));
        if (!token) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        const on = await isAccountLinkingOn(accountLinking, familyId);
        if (!on) {
          set.status = 404;
          return { error: "Not found" };
        }
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const { guestId } = yield* Schema.decodeUnknownEffect(ChooseMemberBody)(raw);
            const database = yield* DbService;
            const [row] = yield* dbQuery(() =>
              database
                .select({ plusOneOf: guests.plusOneOfGuestId, kind: families.kind })
                .from(guests)
                .innerJoin(families, eq(families.id, guests.familyId))
                .where(and(eq(guests.id, guestId), eq(guests.familyId, familyId)))
                .all(),
            );
            if (!row || row.kind !== "guest") return yield* Effect.fail(new NotHouseholdMember());
            if (row.plusOneOf !== null) return yield* Effect.fail(new PlusOneSeat());
            // The write and the link state for the new member need nothing
            // from each other, so they run together.
            const [, state] = yield* Effect.all(
              [
                sessionService.setMember(token, familyId, guestId),
                accountLinkService.householdState(
                  familyId,
                  parseOrganiserSessionToken(request.headers.get("cookie")),
                  {
                    guestId,
                    resolveAccountId: accountLinking.resolveAccountId,
                    avatarOrigins: accountLinking.avatarOrigins,
                  },
                ),
              ],
              { concurrency: "unbounded" },
            );
            yield* Effect.sync(() => metricHouseholdMemberChosen("picked"));
            const { match: _match, ...accountLink } = state;
            return { member: { guestId }, accountLink };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.withSpan("cire.claim.chooseMember"),
            Effect.catchTags({
              SchemaError: () =>
                Effect.sync(() => {
                  set.status = 400;
                  return { error: "Missing or invalid fields" };
                }),
              NotHouseholdMember: () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { error: "not_household_member" };
                }),
              PlusOneSeat: () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { error: "plus_one_seat" };
                }),
              SessionWriteError: () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Could not save your choice" };
                }),
            }),
          ),
        );
      },
      // Sentinel parse hook: the handler parses the body itself, so a
      // malformed payload degrades to the schema's 400.
      { parse: () => ({}) },
    )
    .delete("/member", async ({ familyId, request, set }) => {
      const token = parseSessionToken(request.headers.get("cookie"));
      if (familyId && token) {
        const cleared = await runCire(
          sessionService.setMember(token, familyId, null).pipe(
            Effect.provideService(DbService, db),
            Effect.tap(() => Effect.sync(() => metricHouseholdMemberCleared())),
            Effect.withSpan("cire.claim.clearMember"),
            Effect.as(true),
            // Logged inside the service. The page keeps the member until this
            // answers 2xx, so a failed write must not read as cleared: a
            // reload would bring the last person back.
            Effect.catchTag("SessionWriteError", () => Effect.succeed(false)),
          ),
        );
        if (!cleared) {
          set.status = 500;
          return { error: "Could not clear your choice" };
        }
      }
      set.status = 204;
      return null;
    });
