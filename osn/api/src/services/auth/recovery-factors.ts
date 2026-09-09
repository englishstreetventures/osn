/**
 * Account recovery by a factor that is neither a passkey nor a recovery code:
 * a code emailed to the address on file, or a code from the account's
 * authenticator app.
 *
 * These are the two paths back in for a user who has lost the device and never
 * printed the codes. Neither is a login factor. Both end in the **restricted
 * recovery session** `tokens.ts` builds — `aud: "osn-recovery"`, a 15-minute
 * absolute lifetime, rejected by every verifier in this service and in the three
 * downstream services — whose only privilege is enrolling a passkey. See
 * `[[wiki/architecture/account-recovery-factors]]` §B.
 *
 * Four properties carry this module, and each is enforced here rather than at
 * the routes:
 *
 * - **`begin` answers the same 202 whether or not the identifier resolves**, and
 *   costs roughly the same either way. A uniform body is not enough on its own:
 *   the mail send is the oracle, so it is dispatched detached and both branches
 *   return at probe cost.
 * - **Every branch of every route here makes the same number of store round
 *   trips**, whichever way it ends. A uniform body and a detached send close the
 *   oracle at `begin` and reopen it at `complete` if the branches there are left
 *   to cost what they happen to cost: each store is an HTTP hop to Upstash in
 *   every tier but `local`, so "how many hops did that take" is readable with a
 *   stopwatch and separates a real account from a stranger's guess. Each route
 *   below pins its own count, and the padding always matches the COSTLIEST
 *   branch — padding to the cheapest is the same oracle upside down.
 * - **The recipient is the victim.** The address is the account holder's own, so
 *   the send is capped per resolved account as well as per IP.
 * - **Completion matches `consumeRecoveryCode`**: every session on the account
 *   is revoked and the audit row is written in the same batch, before the new
 *   session exists.
 * - **Every code check is constant-time**, and no code reaches a log line, a
 *   metric attribute, an error body or the OpenAPI document.
 */

import { accounts, passkeys, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { commitBatch } from "@shared/db-utils";
import { type EmailError, EmailService } from "@shared/email";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import { RECOVERY_LOCKOUT_THRESHOLD } from "../../lib/recovery-lockout-store";
import {
  metricAuthOtpSent,
  metricRecoveryCooldown,
  metricRecoveryDisown,
  metricRecoveryEmailBegin,
  metricRecoveryLockout,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAuthLogin,
  withAuthRecovery,
} from "../../metrics";
import {
  MAX_OTP_ATTEMPTS,
  RECOVERY_COOLDOWN_MS,
  RECOVERY_DISOWN_SECRET_BYTES,
  RECOVERY_DISOWN_TTL_MS,
  RECOVERY_OTP_TTL_MS,
} from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import {
  genDisownToken,
  genId,
  genOtpCode,
  hashSessionToken,
  logDevOtp,
  looksLikeEmail,
  normaliseIdentifier,
  parseDisownToken,
  probeAccountId,
} from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { SecurityEventsModule } from "./security-events";
import type { TokensModule } from "./tokens";
import type { TotpModule } from "./totp";
import type {
  ProfileWithEmail,
  PublicProfile,
  RecoveryFactorAmr,
  SessionMeta,
  TokenSet,
} from "./types";
import { toPublicProfile } from "./types";

/**
 * The single failure message every rejected code check answers with. A caller
 * learns the attempt failed and nothing else — not whether the identifier names
 * an account, not whether a code is pending, not whether the account is locked
 * out. `publicError` flattens it to `{ error: "invalid_request" }` before it
 * reaches the wire; the string is what appears in a server-side log.
 */
const GENERIC_FAILURE = "Invalid or expired code";

/** What `begin` answers, on every branch. */
export interface RecoveryEmailBeginResult {
  readonly status: "accepted";
}

export function createRecoveryFactorsModule(
  ctx: AuthContext,
  profiles: ProfilesModule,
  tokens: TokensModule,
  totp: TotpModule,
  securityEventsModule: SecurityEventsModule,
) {
  const { config, stores, hashIp, recoveryEmailBeginCap, recoveryOtpLockoutStore } = ctx;
  const { resolveIdentifier } = profiles;
  const { issueRecoverySession } = tokens;
  const { checkTotpCode, burnTotpCheckCost } = totp;

  const ACCEPTED: RecoveryEmailBeginResult = { status: "accepted" };
  const otpTtlMinutes = RECOVERY_OTP_TTL_MS / 60_000;

  /**
   * Where the "this wasn't me" link points.
   *
   * The origin is DERIVED, not configured: `authorizeUiUrl`'s origin, falling
   * back to the first configured WebAuthn origin — the same precedence
   * `buildInteractionRedirect` uses in `oidc.ts`, so the service has one answer
   * to "where does the frontend live" rather than two that can disagree. A new
   * `Env` key would have to be set in four wrangler environments and the
   * dev-urls map before it was correct anywhere, and would be silently wrong
   * until it was.
   *
   * The token rides in the **fragment**. Corporate mail scanners prefetch every
   * link in a message, and this one is single use — in the query string a
   * security appliance would spend it before the owner read the mail. A
   * fragment is never sent to any server, so it also cannot reach a log.
   *
   * The page that turns this link into the POST lands with the UI phase of this
   * epic, xchromo/osn#953.
   */
  const disownUrl = (token: string): string => {
    const configured = config.authorizeUiUrl;
    const fallback = Array.isArray(config.origin) ? config.origin[0] : config.origin;
    const base = configured ?? fallback ?? "";
    let origin = base;
    try {
      origin = new URL(base).origin;
    } catch {
      // A malformed origin must not fail the recovery that is already
      // committed. The notice still sends; the link is simply not usable.
      origin = base;
    }
    return `${origin}/recovery/disown#token=${encodeURIComponent(token)}`;
  };

  /**
   * Burn one ceremony-store read without creating anything.
   *
   * The unknown-identifier branches use this to pay for the store round trips a
   * resolving caller makes, so response latency does not separate an address
   * that names an account from one that does not. `probeAccountId` is a fresh
   * random id per call (never a fixed sentinel an attacker could seed a row
   * under — see its docstring), so the read is guaranteed to miss at the same
   * indexed cost as a real one.
   *
   * A READ, deliberately. The obvious alternative — running the real cap check
   * or the real lockout against a probe id — writes a counter key per probe
   * request, each with a multi-hour TTL, which turns a latency-equalising
   * measure into unbounded key growth driven by an unauthenticated endpoint.
   */
  const burnProbeRead = (): Effect.Effect<void> =>
    Effect.promise(() => stores.pendingRecoveryOtp.get(probeAccountId())).pipe(Effect.asVoid);

  /**
   * The same, one store along: burn a round trip on the lockout counter.
   *
   * `completeEmailRecovery` touches two stores, so equalising hops on one of
   * them is not enough — the padding has to be able to reach both. `isLocked`
   * is a read; `recordFailure`, the hop it usually stands in for, is a write.
   * That substitution is deliberate and is the same trade {@link burnProbeRead}
   * documents: what a caller can time is the number of round trips, not what
   * each one did, and a write against a probe id leaves a counter key with a
   * fifteen-minute TTL behind for every probe.
   */
  const burnLockoutRead = (): Effect.Effect<void> =>
    Effect.promise(() => recoveryOtpLockoutStore.isLocked(probeAccountId())).pipe(Effect.asVoid);

  /**
   * Send the recovery code, off the request's latency path.
   *
   * Forked detached with a timeout, the shape `notifyRecovery` uses. Awaiting it
   * would make the response an account-existence oracle that no amount of body
   * uniformity can close: a Resend round trip is hundreds of milliseconds and
   * the non-resolving branch's probe is sub-millisecond, so the two branches
   * would be trivially separable by anyone with a stopwatch.
   *
   * The provider's response body — which can echo the recipient — is never
   * logged; only the bounded outcome metric is emitted.
   *
   * `forkBackground`, not a bare `Effect.forkDetach`: it registers the fibre's
   * completion with the request's sink, which the Worker entry hands to
   * `ExecutionContext.waitUntil`. Detached alone would be orphaned on workerd —
   * the request context is torn down once the response is returned — so the
   * code would silently fail to send in the one tier that matters. See
   * `lib/background.ts`.
   */
  const sendRecoveryOtp = (
    recipientEmail: string,
    code: string,
  ): Effect.Effect<void, AuthError, EmailService> =>
    Effect.gen(function* () {
      const email = yield* EmailService;
      yield* email
        .send({
          template: "otp-recovery",
          to: recipientEmail,
          data: { code, ttlMinutes: otpTtlMinutes },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) => new AuthError({ message: `recovery_send_${cause.reason}` }),
          ),
        );
    }).pipe(Effect.withSpan("auth.recovery.otp_send"));

  /**
   * `POST /login/recovery/email/begin` — email an account-recovery code.
   *
   * Always answers {@link ACCEPTED}. The caller cannot tell a delivered code
   * from an unknown address from an account that has hit its cap, and the three
   * branches are told apart only on a dashboard.
   *
   * **Two store round trips on all three**, which is what the sent branch costs
   * (the cap check, then the entry write). The other two are padded up to it.
   *
   * The identifier must be an **email address**: this endpoint puts mail in
   * somebody's inbox, and a handle is public, so accepting one would turn a
   * public identifier into a way to mail a stranger. `/login/passkey/begin` can
   * take a handle precisely because it sends nothing. The check is syntactic —
   * it reads only the submitted string and never touches the database — so
   * refusing a handle discloses nothing about any account.
   */
  const beginEmailRecovery = (
    identifier: string,
  ): Effect.Effect<RecoveryEmailBeginResult, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier).trim().toLowerCase();
      if (!looksLikeEmail(normalised)) {
        return yield* Effect.fail(
          new AuthError({ message: "Enter the email address on the account" }),
        );
      }

      const profile = yield* resolveIdentifier(normalised);
      if (!profile) {
        // Match the resolving branch's two store round trips — one standing in
        // for the cap check, one for the entry write — so the branches cost the
        // same. Parity is APPROXIMATE, not exact, exactly as
        // `consumeRecoveryCode` concedes for its own: the resolving branch also
        // runs `genOtpCode` and a SHA-256, both sub-microsecond and both dwarfed
        // by a single store hop. What the detached send removes is the term that
        // actually mattered.
        yield* burnProbeRead();
        yield* burnProbeRead();
        metricRecoveryEmailBegin("unknown_identifier");
        return ACCEPTED;
      }

      // Keyed on the RESOLVED accountId, never the submitted identifier. Keying
      // on the identifier would let an attacker exhaust a victim's allowance by
      // naming them, and would make the cap itself an existence oracle.
      const allowed = yield* Effect.promise(() => recoveryEmailBeginCap.check(profile.accountId));
      if (!allowed) {
        // Return WITHOUT parking a code. Parking one here would invalidate the
        // code the user is already holding from an earlier send — a denial of
        // service on the account holder, dressed as flood control.
        //
        // The probe read stands in for the entry write skipped just above, so
        // this branch still costs two round trips. Without it, a fourth request
        // for an address whose allowance is spent answers measurably sooner
        // than one for an address that names nobody — which confirms the
        // address is real, and the cap becomes the oracle the uniform 202 was
        // there to prevent.
        yield* burnProbeRead();
        metricRecoveryEmailBegin("capped");
        return ACCEPTED;
      }

      const code = genOtpCode();
      yield* Effect.promise(() =>
        stores.pendingRecoveryOtp.set(
          profile.accountId,
          {
            codeHash: hashSessionToken(code),
            attempts: 0,
            expiresAt: Date.now() + RECOVERY_OTP_TTL_MS,
          },
          RECOVERY_OTP_TTL_MS,
        ),
      );

      // Inert unless the runtime tier is `local` — the same helper the
      // registration, step-up and email-change ceremonies use, and the only way
      // to complete this flow on a dev machine with no inbox.
      yield* logDevOtp("recovery", code);

      yield* forkBackground(
        sendRecoveryOtp(profile.email, code).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.void),
        ),
      );

      metricAuthOtpSent("recovery");
      metricRecoveryEmailBegin("sent");
      return ACCEPTED;
    }).pipe(withAuthRecovery("email_begin"));

  /**
   * Everything both factors do once the code has been believed.
   *
   * Matches `consumeRecoveryCode` deliberately and in detail — that function is
   * the existing recovery ceremony and a second one that revoked less, or
   * recorded less, would be a quieter way into the same account.
   *
   * The wipe and the audit row commit together, and both happen BEFORE the new
   * session is issued. Two reasons, and the ordering satisfies both: a wipe
   * after issuance would delete the session it had just minted, and batching the
   * audit row with the wipe rather than the insert means a failure between the
   * two leaves a recorded recovery and no session — loud and safe — rather than
   * a session nobody can see was created.
   */
  const completeRecoveryFactor = (
    profile: ProfileWithEmail,
    amr: RecoveryFactorAmr,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);

      // One recovery per account per 72 hours, on the two factor paths a
      // mailbox or a stolen seed re-opens at will. Without it the cooldown is
      // no cooldown: the holder simply runs recovery again the moment the owner
      // has cleaned up, and the owner never gets a window in which their
      // credential is the only one that can act.
      //
      // Checked HERE rather than at `begin`, which is the only place both
      // factor paths meet. Two enforcement points would drift, and TOTP has no
      // `begin` to check. It costs the caller the code they just proved, which
      // is the right way round — a refused recovery should not leave a live
      // code behind — and it costs the branch no store round trips, because by
      // this point `completeEmailRecovery` has already made all four.
      //
      // `lastRecoveredAt` rides in on the profile, so this reads nothing: a
      // database hop inside the resolving branch alone would separate a real
      // account from a stranger's guess by latency, which is the oracle the
      // whole module is written to avoid.
      const previousRecovery = profile.lastRecoveredAt;
      if (
        previousRecovery !== null &&
        Date.now() - previousRecovery * 1000 < RECOVERY_COOLDOWN_MS
      ) {
        metricRecoveryCooldown("second_recovery_refused");
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId: profile.accountId,
        kind: "account_recovered",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
        uaLabel: sessionMeta?.uaLabel ?? null,
      };

      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db.delete(sessions).where(eq(sessions.accountId, profile.accountId)),
            db.insert(securityEvents).values(securityEventRow),
            // Opens both windows: the second-recovery refusal above, and the
            // email-change gate's reason to stop trusting an emailed OTP.
            db
              .update(accounts)
              .set({ lastRecoveredAt: nowSec })
              .where(eq(accounts.id, profile.accountId)),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricSessionSecurityInvalidation("account_recovered");
      metricSecurityEventRecorded("account_recovered");

      // The "this wasn't me" lever. Parked before the notice is dispatched, so
      // a token can never reach an inbox before the store can honour it.
      //
      // It is worth being plain about the limit: this goes to `accounts.email`,
      // which in the headline threat — an attacker who holds the mailbox — is
      // the attacker's inbox. The lever is real for a TOTP recovery with the
      // mailbox intact, and for an owner who also reads the mail; it is not a
      // defence against someone who owns the inbox. What protects that owner is
      // the asymmetry itself: their pre-recovery passkey acts immediately.
      const disown = genDisownToken(RECOVERY_DISOWN_SECRET_BYTES);
      yield* Effect.promise(() =>
        stores.recoveryDisownTokens.set(
          disown.lookupId,
          {
            secretHash: hashSessionToken(disown.secret),
            accountId: profile.accountId,
            recoveredAt: nowSec,
            expiresAt: Date.now() + RECOVERY_DISOWN_TTL_MS,
          },
          RECOVERY_DISOWN_TTL_MS,
        ),
      );

      // The audit row is the primary signal and it is already committed; the
      // email is the confirmation, so user-visible latency must not track
      // mailer health. Same shape as every other notice: forked with a timeout
      // and registered with the request's `waitUntil` sink, so the isolate
      // stays alive for it on workerd.
      yield* forkBackground(
        securityEventsModule
          .notifySecurityEventByAccountId(profile.accountId, "account_recovered", "recovery-used", {
            disownUrl: disownUrl(disown.token),
          })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.void),
          ),
      );

      const session = yield* issueRecoverySession(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        // The factor that actually ran, recorded on the session so the passkey
        // enrolment bypass can assert on it rather than on the audience alone.
        amr,
        sessionMeta,
      );

      return { session, profile: toPublicProfile(profile, profile.email) };
    });

  /**
   * `POST /login/recovery/email/complete` — exchange the emailed code for a
   * restricted recovery session.
   *
   * Accepts an email address or a handle. The email-only rule belongs to
   * `begin`, which sends mail; this route sends nothing, and answers the same
   * generic failure to anyone not holding the code.
   *
   * **Four store round trips on every branch** — two on the pending-code store,
   * two on the lockout counter — whether the identifier resolves, whether the
   * account is locked, whether a code is pending and whether the code is right.
   * That is what a wrong code against a live entry costs, and it is the most any
   * branch costs, so every other branch is padded up to it.
   *
   * Uniform bodies are not the whole guard. `begin` answers 202 for an address
   * that names nobody and parks a code for one that does; call it, then call
   * this with a wrong code and time the answer. On unequal branches that reads
   * out as "this address has an account", against no per-account cap and only a
   * 10-per-minute per-IP limiter — which a rotating fleet already defeats at
   * this issuer.
   */
  const completeEmailRecovery = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);

      // Hashed up front on every branch so both pay the same SHA-256, whether or
      // not there is anything to compare it against.
      const codeHash = hashSessionToken(code);

      if (!profile) {
        // The four hops the wrong-code branch makes, in the order it makes
        // them: the lockout lookup, the entry read, the attempt write, the
        // failure record. Two of the four are reads standing in for writes —
        // see `burnLockoutRead`.
        yield* burnLockoutRead();
        yield* burnProbeRead();
        yield* burnProbeRead();
        yield* burnLockoutRead();
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      // Fail-closed: an unreachable counter behind a six-digit code is no
      // throttle at all. The pending code lives in the same store, so an outage
      // fails this ceremony at the next read regardless — closing here costs
      // nothing that was still working.
      const locked = yield* Effect.promise(() =>
        recoveryOtpLockoutStore.isLocked(profile.accountId),
      );
      if (locked) {
        // Read anyway, and pad to four, and answer the same generic failure: a
        // locked account must be indistinguishable from a wrong code, or the
        // lockout becomes its own oracle — and one an attacker can create at
        // will, by spending the account's attempts first.
        yield* Effect.promise(() => stores.pendingRecoveryOtp.get(profile.accountId));
        yield* burnProbeRead();
        yield* burnLockoutRead();
        metricRecoveryLockout("locked");
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      const entry = yield* Effect.promise(() => stores.pendingRecoveryOtp.get(profile.accountId));
      if (!entry || Date.now() > entry.expiresAt) {
        // Deliberately NOT counted as a failed attempt. There is no pending code
        // here, so this is not a guess against anything — and counting it would
        // hand anyone who knows the identifier a lever to lock the owner out of
        // their own recovery without ever guessing a digit.
        //
        // It still has to COST what counting one costs. Otherwise "no code
        // pending" is timeable, and since `begin` parks a code only for an
        // address that resolves, that is the account-existence oracle again by
        // another route.
        yield* burnProbeRead();
        yield* burnLockoutRead();
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      if (!timingSafeEqualString(entry.codeHash, codeHash)) {
        const attempts = entry.attempts + 1;
        if (attempts >= MAX_OTP_ATTEMPTS) {
          yield* Effect.promise(() => stores.pendingRecoveryOtp.delete(profile.accountId));
        } else {
          yield* Effect.promise(() =>
            stores.pendingRecoveryOtp.set(
              profile.accountId,
              { ...entry, attempts },
              Math.max(0, entry.expiresAt - Date.now()),
            ),
          );
        }
        // The per-entry cap and this counter coincide on the first entry by
        // construction (both are 5). What the counter adds is the SECOND and
        // THIRD entries: without it the 3-per-24h send cap would still allow
        // fifteen guesses inside the lockout window.
        const failures = yield* Effect.promise(() =>
          recoveryOtpLockoutStore.recordFailure(profile.accountId),
        );
        if (failures >= RECOVERY_LOCKOUT_THRESHOLD) {
          metricRecoveryLockout("locked");
          yield* recordLockoutEvent(profile.accountId, sessionMeta);
        } else {
          metricRecoveryLockout("recorded");
        }
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      yield* Effect.promise(() => stores.pendingRecoveryOtp.delete(profile.accountId));
      yield* Effect.promise(() => recoveryOtpLockoutStore.reset(profile.accountId));
      metricRecoveryLockout("reset");

      return yield* completeRecoveryFactor(profile, "otp", sessionMeta);
    }).pipe(withAuthRecovery("email_complete"), withAuthLogin("email_recovery"));

  /**
   * Write the `recovery_otp_lockout` audit row when an account crosses the
   * failed-attempt threshold, so the owner sees "repeated failed recovery
   * attempts" in the security banner even though every attempt answered the
   * same generic error over the wire.
   *
   * Best-effort: a write failure is logged and never turns the already-correct
   * generic failure into a 500. Mirrors `recordRecoveryLockoutEvent` in
   * `recovery.ts`.
   */
  const recordLockoutEvent = (
    accountId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<void, never, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(securityEvents).values({
            id: genId("sev_"),
            accountId,
            kind: "recovery_otp_lockout",
            createdAt: nowSec,
            acknowledgedAt: null,
            ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
            uaLabel: eventMeta?.uaLabel ?? null,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(
        Effect.tap(() => Effect.sync(() => metricSecurityEventRecorded("recovery_otp_lockout"))),
        Effect.catch((cause) =>
          Effect.logWarning("auth.recovery.otp_lockout: audit write failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("auth.recovery.otp_lockout"));

  /**
   * `POST /login/recovery/totp/complete` — exchange an authenticator code for a
   * restricted recovery session.
   *
   * The path for a user who has lost the device **and** cannot reach the
   * mailbox. `checkTotpCode` owns the per-account lockout, the single-use step
   * consumption RFC 6238 §5.2 requires, and the constant-cost branch for an
   * account with no authenticator — going through it rather than re-deriving the
   * check is what keeps all three from being forgotten here.
   *
   * The `"recovery"` scope is load-bearing: it keys the lockout separately from
   * `POST /step-up/totp/complete`, so failures at this unauthenticated route
   * cannot lock the authenticated ceremony for anyone who knows a handle.
   *
   * **The identifier may be an email address**, which is what makes the cost of
   * the non-resolving branch a security property rather than a nicety: a
   * cheaper miss here lets an unauthenticated caller ask "does this address
   * have an OSN account", with no per-account cap in front of it. So that
   * branch pays `burnTotpCheckCost` — the same lockout lookup, credential query
   * and dummy-key verification a real unlocked account pays for.
   */
  const completeTotpRecovery = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);

      if (!profile) {
        // Mirror the cost of the branch `checkTotpCode` would have taken —
        // written next to that function rather than here, so the two cannot
        // drift. It runs the lockout lookup, the credential query and the
        // dummy-key verification against a probe id; no counter is written,
        // because a probe must not leave a lockout key behind.
        yield* burnTotpCheckCost(code);
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      yield* checkTotpCode(profile.accountId, code, "recovery");
      return yield* completeRecoveryFactor(profile, "totp", sessionMeta);
    }).pipe(withAuthRecovery("totp_complete"), withAuthLogin("totp_recovery"));

  /** What `POST /recovery/disown` answers, on every branch. */
  const DISOWN_ACCEPTED: RecoveryEmailBeginResult = { status: "accepted" };

  /**
   * `POST /recovery/disown` — the "this wasn't me" lever from the recovery
   * notice.
   *
   * Answers the same 202 whether the token was good, wrong, spent, expired, or
   * belonged to an account whose only credentials are the ones it would revoke.
   * The token is a 256-bit secret, so there is nothing to enumerate — but the
   * uniform answer costs nothing and removes the need to argue about it.
   *
   * **Two store round trips on every branch a stranger can reach.** A `get`
   * and an atomic `consume` when the token is accepted; a `get` and a probe
   * `get` when it is not. The database work sits behind the secret and is not
   * reachable by probing, and neither is the third hop that re-parks the token
   * when the revocation write fails.
   *
   * What it does, and why each part is wider or narrower than the obvious:
   *
   * - **Revokes the credentials that recovery produced**, filtered on
   *   provenance as well as time. A bare `created_at >= recoveredAt` would also
   *   delete a credential the owner enrolled afterwards by asserting a
   *   pre-recovery passkey — a `webauthn`-provenance row that is exactly the
   *   thing the owner needs to keep.
   * - **Never below one passkey.** Guarded inside the statement, so a race
   *   cannot slip past it. When the revocable credentials are the account's
   *   only ones the account keeps them and the sessions still go — the
   *   invariant wins, and the outcome says so.
   * - **Revokes every session, not just the recovery family.** Every session on
   *   the account postdates the recovery, because completing one deletes them
   *   all; and the attacker's ordinary sign-in with their new credential starts
   *   a DIFFERENT family, which family-scoped revocation would leave alive.
   * - **Clears `last_recovered_at` — but only the recovery this token names.**
   *   Otherwise one click on a link in a mailbox turns an honest owner's
   *   recovery into a 72-hour lockout: their new credential is deleted, their
   *   sessions are gone, and the second-recovery refusal stops them getting
   *   back in. "This wasn't me" is by definition a request to be allowed to
   *   recover again. That argument is about the recovery the token was minted
   *   for, so a LATER recovery's window is left standing — see
   *   `revokeDisownedRecovery`.
   *
   * **The one branch that does not answer 202** is a database failure after the
   * token has matched. Reporting "accepted" there would be a lie about the only
   * lever the account owner has, and the counter that exists to tell a real
   * revocation from a no-op would say the lever fired. Nothing is enumerable by
   * then — the writes sit behind a 256-bit secret that has already matched — so
   * a 5xx costs no privacy, and the token is re-parked so the click can be
   * repeated.
   */
  const disownRecovery = (
    token: string,
  ): Effect.Effect<RecoveryEmailBeginResult, DatabaseError, Db> =>
    Effect.gen(function* () {
      const parsed = parseDisownToken(token);
      // A malformed token still pays for both hops, so "that was not even the
      // right shape" is not measurably cheaper than "that was wrong".
      const lookupId = parsed?.lookupId ?? genId("rdt_");

      const entry = yield* Effect.tryPromise({
        try: () => stores.recoveryDisownTokens.get(lookupId),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("auth.recovery.disown: token store unreadable").pipe(
            Effect.annotateLogs({ error: String(cause) }),
            Effect.as(undefined),
          ),
        ),
      );

      const usable =
        parsed !== null &&
        entry !== undefined &&
        entry !== null &&
        Date.now() <= entry.expiresAt &&
        timingSafeEqualString(entry.secretHash, hashSessionToken(parsed.secret));

      if (!usable) {
        yield* burnDisownProbeRead();
        // An unreadable store and a wrong token are the same to the caller, and
        // must be: the outage revokes nothing, which is the fail-closed answer,
        // and only the counter says which happened.
        metricRecoveryDisown(entry === undefined ? "store_error" : "invalid");
        return DISOWN_ACCEPTED;
      }

      // Single use, claimed ATOMICALLY — the guarantee `StepUpJtiStore.consume`
      // gives a step-up jti, for the same reason. A `get` above followed by a
      // plain `delete` here lets two concurrent presentations of one token both
      // pass the check and both revoke; the claim makes the first consumer the
      // only one. Claimed BEFORE the revocation, so the token cannot be spent
      // twice even if the writes below fail.
      const claimed = yield* Effect.tryPromise({
        try: () => stores.recoveryDisownTokens.consume(lookupId),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("auth.recovery.disown: token claim failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
            Effect.as(null),
          ),
        ),
      );
      if (claimed !== true) {
        // `false` is a lost race: another presentation of this token got there
        // first and is doing the work, so this one is a replay. `null` is a
        // store outage, which revokes nothing — the same fail-closed posture as
        // an unreadable store above.
        metricRecoveryDisown(claimed === false ? "invalid" : "store_error");
        return DISOWN_ACCEPTED;
      }

      const outcome = yield* revokeDisownedRecovery(entry.accountId, entry.recoveredAt).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            metricRecoveryDisown("revoke_failed");
            // Put the token back so the owner's second click works. The writes
            // are idempotent, so re-parking cannot do harm even where the batch
            // had in fact landed and only the acknowledgement was lost.
            yield* Effect.promise(() =>
              stores.recoveryDisownTokens.set(
                lookupId,
                entry,
                Math.max(0, entry.expiresAt - Date.now()),
              ),
            ).pipe(Effect.catch(() => Effect.void));
          }),
        ),
      );
      metricRecoveryDisown(outcome);
      return DISOWN_ACCEPTED;
    }).pipe(withAuthRecovery("disown"));

  /** Burn one disown-store read, so a refusal costs what an acceptance costs. */
  const burnDisownProbeRead = (): Effect.Effect<void> =>
    Effect.promise(() => stores.recoveryDisownTokens.get(genId("rdt_"))).pipe(
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    );

  /**
   * The writes behind an accepted disown. Split out so the branch table above
   * stays readable and so the last-passkey guard is in one place.
   *
   * **Nothing here is swallowed.** Every failure leaves the caller a 5xx and
   * the `revoke_failed` counter, because the return value is computed from an
   * in-memory read and would otherwise report a revocation that never
   * happened — on the one lever the account owner has, with no way to see it
   * and no way to retry. `completeRecoveryFactor`'s batch fails loudly for the
   * same reason, and these two writes are the same kind of thing.
   *
   * **The token names ONE recovery, and this is scoped to it.** `recoveredAt`
   * is frozen at mint time and the token lives 72 hours, but the
   * recovery-CODE path is deliberately exempt from the one-recovery-per-72h
   * cap and re-stamps `accounts.last_recovered_at` on every use. So a second,
   * legitimate recovery can land while an earlier token is still live, and an
   * unscoped run would reach through it: revoking the credentials that second
   * recovery produced, and clearing a window that has nothing to do with the
   * recovery being disowned. Both are bounded here — the revocation by an
   * upper bound at the later recovery, the clear by a compare-and-set on the
   * value the token was minted against.
   */
  const revokeDisownedRecovery = (
    accountId: string,
    recoveredAt: number,
  ): Effect.Effect<"accepted" | "kept_last_passkey", DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);

      const accountPasskeys = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: passkeys.id,
              createdAt: passkeys.createdAt,
              provenanceAmr: passkeys.provenanceAmr,
            })
            .from(passkeys)
            .where(eq(passkeys.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const [account] = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ lastRecoveredAt: accounts.lastRecoveredAt })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // A recovery later than the one this token names, if there is one. Only
      // the recovery-code path can produce it inside the window; the two factor
      // paths are capped. `null` covers "no later recovery" and "already
      // cleared", which want the same treatment: no upper bound.
      const current = account?.lastRecoveredAt ?? null;
      const laterRecovery = current !== null && current > recoveredAt ? current : null;

      // A NULL provenance is a row older than the column, so it is not one this
      // recovery produced whatever its timestamp says.
      const revocable = accountPasskeys.filter((row) => {
        const createdAtSec = Math.floor(row.createdAt.getTime() / 1000);
        if (createdAtSec < recoveredAt) return false;
        if (laterRecovery !== null && createdAtSec >= laterRecovery) return false;
        return (
          row.provenanceAmr === "recovery" ||
          row.provenanceAmr === "otp" ||
          row.provenanceAmr === "totp"
        );
      });
      const keepsOne = accountPasskeys.length > revocable.length;

      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "recovery_disowned",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: null,
        uaLabel: null,
      };

      const statements: BatchItem<"sqlite">[] = [];
      if (revocable.length > 0 && keepsOne) {
        statements.push(
          db.delete(passkeys).where(
            and(
              eq(passkeys.accountId, accountId),
              inArray(
                passkeys.id,
                revocable.map((row) => row.id),
              ),
              // Re-assert the survivor count in the same statement. The read
              // above is not a transaction on D1, so this is what makes the
              // last-passkey invariant race-safe against a concurrent delete.
              sql`(select count(*) from ${passkeys} where ${passkeys.accountId} = ${accountId}) > ${revocable.length}`,
            ),
          ),
        );
      }
      statements.push(
        db.delete(sessions).where(eq(sessions.accountId, accountId)),
        db.insert(securityEvents).values(securityEventRow),
        db
          .update(accounts)
          .set({ lastRecoveredAt: null })
          // Compare-and-set on the value the token was minted against, so a
          // recovery that landed AFTER it keeps its own window. Without the
          // second clause a stale token would end a later recovery's cooldown
          // early — re-opening the second-recovery cap and the email-change
          // gate for whoever is holding the mailbox. It is also why this is
          // safe against a race with a concurrent recovery: the statement
          // matches nothing once the row has moved on.
          .where(and(eq(accounts.id, accountId), eq(accounts.lastRecoveredAt, recoveredAt))),
      );

      yield* Effect.tryPromise({
        try: () => commitBatch(db, statements),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricSessionSecurityInvalidation("recovery_disowned");
      metricSecurityEventRecorded("recovery_disowned");
      return revocable.length > 0 && !keepsOne ? "kept_last_passkey" : "accepted";
    });

  return {
    beginEmailRecovery,
    completeEmailRecovery,
    completeTotpRecovery,
    disownRecovery,
  };
}

export type RecoveryFactorsModule = ReturnType<typeof createRecoveryFactorsModule>;
