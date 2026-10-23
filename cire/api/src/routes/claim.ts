import { families, guests } from "@cire/db";
import { GUEST_EMAIL_CONSENT, parseGuestEmail } from "@cire/guest-email";
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
import {
  metricGuestEmailBlocked,
  metricHouseholdMemberChosen,
  metricHouseholdMemberCleared,
} from "../metrics";
import { sessionAuth } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { turnstileGate } from "../middleware/turnstile";
import { runCire } from "../observability";
import {
  type AccountLinkState,
  ChooseMemberBody,
  ClaimBody,
  GuestEmailBody,
  GuestEmailRemoveBody,
} from "../schemas/claim";
import { accountLinkService } from "../services/account-link";
import { type AccountLinkGate, claimService } from "../services/claim";
import {
  type GuestEmailSeatRefused,
  guestEmailService,
  type SeatRefusal,
} from "../services/guest-email";
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
    memberStepExcludedWeddings: linking.memberStepExcludedWeddings,
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
          // effort — the next restore chooses again if this write fails — so
          // in a Worker it runs after the response, held by `waitUntil`.
          const chosen = result.member?.guestId ?? null;
          const token = parseSessionToken(request.headers.get("cookie"));
          if (memberGuestId === null && chosen !== null && token) {
            const write = sessionService.setMember(token, familyId, chosen).pipe(
              Effect.tap(() => Effect.sync(() => metricHouseholdMemberChosen("auto_single"))),
              Effect.catchTag("SessionWriteError", () => Effect.void),
            );
            const waitUntil = getWaitUntil(request);
            if (waitUntil) waitUntil(runCire(write.pipe(Effect.provideService(DbService, db))));
            else yield* write;
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
  /** Decides whether the answer carries the household's account-link state. */
  accountLinking: AccountLinking;
}

const LINKING_OFF: AccountLinkState = { enabled: false };

/**
 * The weddings kept out of the member step for this household right now: the
 * excluded list while account linking is off for it, else none. Reads the
 * flag only when the list is not empty, as `POST /member` does. The routes
 * start it before reading the body and the seat read awaits it, so the waits
 * overlap.
 */
async function memberStepOffFor(
  linking: AccountLinking,
  familyId: string,
  request: Request,
): Promise<ReadonlySet<string>> {
  const excluded = linking.memberStepExcludedWeddings ?? new Set<string>();
  if (excluded.size === 0) return excluded;
  const waitUntil = getWaitUntil(request);
  const on = isAccountLinkingOn(linking, familyId, waitUntil);
  waitUntil?.(on);
  return (await on) ? new Set<string>() : excluded;
}

/** The status and body a refused seat answers with. */
function seatRefusal(
  reason: SeatRefusal,
  set: { status?: number | string },
): Effect.Effect<{ error: string }> {
  return Effect.logWarning("guest email refused", { reason }).pipe(
    Effect.andThen(
      Effect.sync(() => {
        metricGuestEmailBlocked(reason);
        switch (reason) {
          case "not_a_guest":
            set.status = 403;
            return { error: "not_a_guest" };
          case "member_step_off":
            // As `POST /member` answers in such a wedding: the step does not exist.
            set.status = 404;
            return { error: "Not found" };
          case "member_required":
          case "member_changed":
            set.status = 409;
            return { error: reason };
        }
      }),
    ),
  );
}

/** A refused address: the bounded reason is logged and counted, never the address. */
function addressRefusal(
  reason: "invalid" | "consent_outdated",
  set: { status?: number | string },
): Effect.Effect<{ error: string }> {
  return Effect.logWarning("guest email refused", { reason }).pipe(
    Effect.andThen(
      Effect.sync(() => {
        metricGuestEmailBlocked(reason);
        if (reason === "invalid") {
          set.status = 400;
          return { error: "invalid_email" };
        }
        set.status = 422;
        return { error: "email_consent_outdated" };
      }),
    ),
  );
}

/** A write that did not commit. */
function writeFailed(
  message: string,
  set: { status?: number | string },
): Effect.Effect<{ error: string }> {
  return Effect.logError("guest email write failed").pipe(
    Effect.andThen(
      Effect.sync(() => {
        set.status = 500;
        return { error: message };
      }),
    ),
  );
}

/** The guest named is not a member of the session's household. */
class NotHouseholdMember extends Data.TaggedError("NotHouseholdMember") {}
/** The guest named is a plus-one, whose row another guest typed in. */
class PlusOneSeat extends Data.TaggedError("PlusOneSeat") {}
/** The household's wedding is excluded from the member step and linking is off. */
class MemberStepOff extends Data.TaggedError("MemberStepOff") {}
/** The session ended between its check and the write. */
class SessionGone extends Data.TaggedError("SessionGone") {}

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
 * The step is on for every guest household but those of a wedding listed in
 * `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS`, where it is on only while
 * `cire.account-linking` is: off, `POST` answers 404 and records nothing.
 * Otherwise `POST` answers 200 with the
 * member and the household's account-link state for that member, since only
 * the server can tell whether this browser's sign-in is the account the member
 * is linked to. While `cire.account-linking` is off for the household that
 * state is `{ enabled: false }`, naming no musubi account. The flag read is
 * the stale-ok one the claim payload makes: it only shapes the answer, and the
 * link POST enforces the flag itself. `DELETE` is idempotent: 204, or 500
 * when the write fails.
 * Both are behind `originGuard` (mounted after it in `app.ts`).
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
        // Started here so it overlaps the body read and the write. A refusal
        // can answer before it settles, so `waitUntil` holds it: a flag
        // refresh it started is shared with the isolate's later requests. It
        // never rejects.
        const waitUntil = getWaitUntil(request);
        const linkingRead = isAccountLinkingOn(accountLinking, familyId, waitUntil);
        waitUntil?.(linkingRead);
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const { guestId } = yield* Schema.decodeUnknownEffect(ChooseMemberBody)(raw);
            const excluded = accountLinking.memberStepExcludedWeddings ?? new Set<string>();
            // Excluded weddings are refused inside the write while linking is
            // off, so then the flag is needed first; otherwise its read
            // overlaps the write.
            const keptOut =
              excluded.size > 0 && !(yield* Effect.promise(() => linkingRead)) ? [...excluded] : [];
            const linkState: Effect.Effect<AccountLinkState, never, DbService> = Effect.promise(
              () => linkingRead,
            ).pipe(
              Effect.flatMap((on): Effect.Effect<AccountLinkState, never, DbService> =>
                on
                  ? accountLinkService
                      .householdState(
                        familyId,
                        parseOrganiserSessionToken(request.headers.get("cookie")),
                        {
                          guestId,
                          resolveAccountId: accountLinking.resolveAccountId,
                          avatarOrigins: accountLinking.avatarOrigins,
                        },
                      )
                      .pipe(Effect.map(({ match: _match, ...state }) => state))
                  : Effect.succeed(LINKING_OFF),
              ),
            );
            // The checked write, the link state for the new member and their
            // own address need nothing from each other, so they run together.
            // The address is read for the household's own guest only and
            // returned only once the write has accepted the choice.
            const [written, accountLink, email] = yield* Effect.all(
              [
                sessionService.chooseMember(token, familyId, guestId, keptOut),
                linkState,
                guestEmailService.memberEmail(familyId, guestId),
              ],
              { concurrency: "unbounded" },
            );
            if (!written) {
              // Refused: one read says which check it was. The member step
              // can only be off here for an excluded wedding with linking off.
              const database = yield* DbService;
              const [row] = yield* dbQuery(() =>
                database
                  .select({
                    plusOneOf: guests.plusOneOfGuestId,
                    kind: families.kind,
                    weddingId: families.weddingId,
                  })
                  .from(guests)
                  .innerJoin(families, eq(families.id, guests.familyId))
                  .where(and(eq(guests.id, guestId), eq(guests.familyId, familyId)))
                  .all(),
              );
              if (!row || row.kind !== "guest") return yield* Effect.fail(new NotHouseholdMember());
              if (row.plusOneOf !== null) return yield* Effect.fail(new PlusOneSeat());
              if (keptOut.includes(row.weddingId)) return yield* Effect.fail(new MemberStepOff());
              // The guest passes every check, so the session itself went
              // between `sessionAuth` and the write.
              return yield* Effect.fail(new SessionGone());
            }
            yield* Effect.sync(() => metricHouseholdMemberChosen("picked"));
            return { member: email ? { guestId, email } : { guestId }, accountLink };
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
              MemberStepOff: () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Not found" };
                }),
              SessionGone: () =>
                Effect.sync(() => {
                  set.status = 401;
                  return { error: "Unauthorized" };
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
    })
    /**
     * `PUT` / `DELETE /api/claim/member/email` — the chosen member's own
     * address. `PUT { memberGuestId, email, consentVersion }` stores it under
     * the guest's consent, recording an address the hosts added that it
     * replaces as the member's opt-out; `DELETE { memberGuestId }` removes it
     * and, when the hosts added it, records the member's opt-out, so the
     * wedding never mails it again until this seat gives it back; an address
     * the guest gave themselves is removed and leaves no opt-out. Refused, in
     * this order: a host preview
     * (403), a wedding without the member step (404), no member chosen or a
     * page showing another member (409), then for `PUT` an address that is not
     * one (400), consent to words the page did not show (422), and an address
     * the seat did not withdraw itself once it holds its cap of opt-outs (429).
     * Never logs the address.
     */
    .put(
      "/member/email",
      async ({ familyId, memberGuestId, request, set }) => {
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        // Started before the body is read, and awaited after the seat read.
        const memberStepOff = memberStepOffFor(accountLinking, familyId, request);
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknownEffect(GuestEmailBody)(raw);
            // The seat is checked before the address, so a refused seat learns
            // nothing about the address rule. Only a save reads the opt-outs.
            const seat = yield* guestEmailService.resolveSeat({
              familyId,
              sessionMember: memberGuestId,
              bodyMember: body.memberGuestId,
              memberStepOff,
              countOptOuts: true,
            });
            const address = parseGuestEmail(body.email);
            if (address === null) return yield* addressRefusal("invalid", set);
            if (body.consentVersion !== GUEST_EMAIL_CONSENT.version) {
              return yield* addressRefusal("consent_outdated", set);
            }
            const email = yield* guestEmailService.setOwn(seat, address);
            return { email };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTags({
              SchemaError: () =>
                Effect.sync(() => {
                  set.status = 400;
                  return { error: "Missing or invalid fields" };
                }),
              GuestEmailSeatRefused: (e: GuestEmailSeatRefused) => seatRefusal(e.reason, set),
              GuestEmailTooManyChanges: () =>
                Effect.logWarning("guest email refused", { reason: "too_many_changes" }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      metricGuestEmailBlocked("too_many_changes");
                      set.status = 429;
                      return { error: "too_many_changes" };
                    }),
                  ),
                ),
              GuestEmailWriteError: () => writeFailed("Could not save your email", set),
            }),
          ),
        );
      },
      { parse: () => ({}) },
    )
    .delete(
      "/member/email",
      async ({ familyId, memberGuestId, request, set }) => {
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        const memberStepOff = memberStepOffFor(accountLinking, familyId, request);
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknownEffect(GuestEmailRemoveBody)(raw);
            const seat = yield* guestEmailService.resolveSeat({
              familyId,
              sessionMember: memberGuestId,
              bodyMember: body.memberGuestId,
              memberStepOff,
            });
            yield* guestEmailService.removeOwn(seat);
            return { email: null };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTags({
              SchemaError: () =>
                Effect.sync(() => {
                  set.status = 400;
                  return { error: "Missing or invalid fields" };
                }),
              GuestEmailSeatRefused: (e: GuestEmailSeatRefused) => seatRefusal(e.reason, set),
              GuestEmailWriteError: () => writeFailed("Could not remove your email", set),
            }),
          ),
        );
      },
      { parse: () => ({}) },
    );
