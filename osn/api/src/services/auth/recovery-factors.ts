/**
 * Account recovery by a factor that is neither a passkey nor a recovery code:
 * a link emailed to the address on file, or a code from the account's
 * authenticator app.
 *
 * These are the two paths back in for a user who has lost the device and never
 * printed the codes. Neither is a login factor. Both end in the **restricted
 * recovery session** `tokens.ts` builds — `aud: "osn-recovery"`, a 15-minute
 * absolute lifetime, rejected by every verifier in this service and in the three
 * downstream services — whose only privilege is enrolling a passkey. See
 * `[[wiki/osn/account-recovery-factors]]` §B.
 *
 * The email path is a flow of the shared emailed-link challenge
 * (`email-link.ts`): begin opens a request and answers the tab that began with
 * its request id, claim secret and pairing number; the link only confirms;
 * the tab polls with the claim secret and, once the link is confirmed, gets the
 * restricted session. The device that opens the link gets nothing.
 *
 * What this module holds to, and enforces here rather than at the routes:
 *
 * - **Every branch answers alike and costs alike.** Begin, a poll and a Resend
 *   give the same answer, after the same store calls and database queries,
 *   whether or not the address names an account: an address with no account
 *   gets a request of its own that is never mailed. The send runs after the
 *   answer, so a mail round trip is no oracle.
 * - **The recipient is the victim.** The address is the account holder's own,
 *   so recovery links are capped per account and client address, and Resends
 *   per account: each address that asks has its own allowance, and a begin's
 *   first link never counts against the account's Resends.
 * - **Completion matches `consumeRecoveryCode`**: every session on the account
 *   is revoked and the audit row is written in the same batch, before the new
 *   session exists.
 * - **No secret reaches a log line**, a metric attribute, an error body or the
 *   OpenAPI document; every code check is constant-time.
 */

import { accounts, passkeys, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { commitBatch, jsonEachIn } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import {
  metricEmailLinkSend,
  metricRecoveryCooldown,
  metricRecoveryDisown,
  metricRecoveryEmailBegin,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAuthLogin,
  withAuthRecovery,
} from "../../metrics";
import {
  RECOVERY_COOLDOWN_MS,
  RECOVERY_DISOWN_SECRET_BYTES,
  RECOVERY_DISOWN_TTL_MS,
  RECOVERY_LINK_TTL_MS,
} from "./constants";
import type { AuthContext } from "./context";
import type { EmailLinkModule } from "./email-link";
import { AuthError, type CoordinationError, DatabaseError } from "./errors";
import {
  frontendOrigin,
  genDisownToken,
  genId,
  hashSessionToken,
  logDevLink,
  looksLikeEmail,
  normaliseIdentifier,
  parseDisownToken,
} from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { SecurityEventsModule } from "./security-events";
import { storeCall } from "./store-call";
import type { EmailLinkChallenge } from "./stores";
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
 * The single failure message every rejected check answers with. A caller
 * learns the attempt failed and nothing else — not whether the identifier names
 * an account, not whether a code is pending, not whether the account is locked
 * out. `publicError` flattens it to `{ error: "invalid_request" }` before it
 * reaches the wire; the string is what appears in a server-side log.
 */
const GENERIC_FAILURE = "Invalid or expired code";

/** What email recovery's begin answers, on every branch: the request the tab that began holds. */
export interface RecoveryEmailBegun {
  readonly requestId: string;
  /** Kept by the tab that began; whoever holds it receives the restricted session. */
  readonly claimSecret: string;
  /** Shown by the tab that began; the link's confirm step asks for it. */
  readonly pairingCode: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** What an email-recovery status poll answers. */
export type RecoveryEmailStatus =
  | {
      readonly status: "pending";
      /** The number the waiting screen shows, for a tab that has lost it. */
      readonly pairingCode?: string;
    }
  | { readonly status: "expired" }
  | {
      readonly status: "complete";
      readonly session: TokenSet;
      readonly profile: PublicProfile;
    };

/** What `POST /recovery/disown` answers, on every branch. */
export interface RecoveryDisownAccepted {
  readonly status: "accepted";
}

const EXPIRED = { status: "expired" } as const;

export function createRecoveryFactorsModule(
  ctx: AuthContext,
  profiles: ProfilesModule,
  tokens: TokensModule,
  totp: TotpModule,
  securityEventsModule: SecurityEventsModule,
  links: EmailLinkModule,
) {
  const {
    config,
    stores,
    hashIp,
    serverMac,
    recoveryLinkAddressCap,
    recoveryResendCap,
    recoveryLinkCeiling,
    recoveryOtpLockoutStore,
  } = ctx;
  const { resolveIdentifier, findDefaultProfile } = profiles;
  const { issueRecoverySession } = tokens;
  const { checkTotpCode, burnTotpCheckCost } = totp;

  const linkTtlMinutes = RECOVERY_LINK_TTL_MS / 60_000;

  /**
   * Where the "this wasn't me" link points: {@link frontendOrigin}.
   *
   * The token rides in the **fragment**. Corporate mail scanners prefetch every
   * link in a message, and this one is single use — in the query string a
   * security appliance would spend it before the owner read the mail. A
   * fragment is never sent to any server, so it also cannot reach a log.
   */
  // A malformed origin must not fail the recovery that is already committed:
  // `frontendOrigin` answers it as given, so the notice still sends.
  const disownUrl = (token: string): string =>
    `${frontendOrigin(config)}/recovery/disown#token=${encodeURIComponent(token)}`;

  /**
   * The keyed digest of an address a recovery request is bound to: the
   * address the link went to, which the claim and a Resend check again.
   */
  const addressDigest = (address: string): string =>
    serverMac.probeKey(address.trim().toLowerCase());

  /**
   * Mails a recovery link for `accountId` to `address`, after the answer: the
   * caller forks it, registered with the request's `waitUntil`
   * (`forkBackground`), so the send still runs on workerd once the response is
   * out and adds nothing to the time to answer. The account's limits are read
   * here, so they cost the answer nothing and are reached only where a link
   * would go out:
   *
   *  - no link goes to an account its recovery lockout holds, or whose
   *    lockout cannot be read;
   *  - every link counts against the allowance of the account at the client
   *    address that asked (`recoverySendKey`), so requests from one address
   *    never use another's;
   *  - a Resend's link also counts against the account's Resends a day. A
   *    begin's first link does not, so the newest request always gets its
   *    first link whoever has spent the Resends;
   *  - every link that passes those counts against the account's ceiling on
   *    recovery mail, which bounds the mail one mailbox can be sent however
   *    many addresses ask. Past it, nothing is sent; begin answers as ever.
   *
   * A held-back or failed send is counted and goes no further; the transport
   * has already logged why a send failed. The provider's response body —
   * which can echo the recipient — is never logged. The request stays live
   * either way, and Resend on it is the retry.
   */
  const sendRecoveryLink = (
    accountId: string,
    address: string,
    url: string,
    ttlMinutes: number,
    kind: "first" | "resend",
    sessionMeta?: SessionMeta,
  ): Effect.Effect<void, never, EmailService> =>
    Effect.gen(function* () {
      const lockout = yield* Effect.promise(() => recoveryOtpLockoutStore.status(accountId));
      const sendKey = serverMac.recoverySendKey(accountId, sessionMeta?.ip ?? "");
      const allowed =
        lockout.status === "open" &&
        (yield* Effect.promise(() => recoveryLinkAddressCap.check(sendKey))) &&
        (kind === "first" || (yield* Effect.promise(() => recoveryResendCap.check(accountId)))) &&
        (yield* Effect.promise(() => recoveryLinkCeiling.check(serverMac.probeKey(accountId))));
      if (!allowed) {
        metricEmailLinkSend("recovery", "capped");
        return;
      }
      const emailSvc = yield* EmailService;
      yield* emailSvc
        .send({
          template: "link-recovery",
          to: address,
          data: {
            url,
            ttlMinutes,
            instanceName: config.instanceName,
            device: sessionMeta?.uaLabel ?? null,
          },
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.tap(() => Effect.sync(() => metricEmailLinkSend("recovery", "sent"))),
          Effect.catch(() => Effect.sync(() => metricEmailLinkSend("recovery", "failed"))),
        );
    }).pipe(Effect.withSpan("auth.recovery.link_send"));

  /**
   * `POST /login/recovery/email/begin` — email a recovery link.
   *
   * Answers {@link RecoveryEmailBegun} on every branch, after the same calls:
   * one database query to resolve the address, then one store write that opens
   * the request. An address with no account gets a request about its probe
   * key, which is never mailed, so its poll stays `pending` until it expires as
   * an unconfirmed real one does. Whether the address has an account, and
   * whether its link was held back, show only on a dashboard.
   *
   * Several requests for one account may be live at once: a stranger's begin
   * neither replaces nor blocks the owner's.
   *
   * The identifier must be an **email address**: this endpoint puts mail in
   * somebody's inbox, and a handle is public, so accepting one would turn a
   * public identifier into a way to mail a stranger. The check is syntactic —
   * it reads only the submitted string and never touches the database — so
   * refusing a handle discloses nothing about any account.
   */
  const beginEmailRecovery = (
    identifier: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    RecoveryEmailBegun,
    AuthError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      if (!looksLikeEmail(normalised)) {
        return yield* Effect.fail(
          new AuthError({ message: "Enter the email address on the account" }),
        );
      }

      const profile = yield* resolveIdentifier(identifier);
      const bound = addressDigest(normalised);
      const opened = yield* links.open(
        "recovery",
        profile ? profile.accountId : bound,
        RECOVERY_LINK_TTL_MS,
        { bound },
      );
      const answer: RecoveryEmailBegun = {
        requestId: opened.requestId,
        claimSecret: opened.claimSecret,
        pairingCode: opened.pairingCode,
        expiresAt: Math.floor(opened.expiresAt / 1000),
      };
      if (!profile) {
        metricRecoveryEmailBegin("unknown_identifier");
        return answer;
      }

      // Inert unless the runtime tier is `local`: the only way to finish this
      // flow on a dev machine with no inbox.
      yield* logDevLink("recovery", opened.url);
      yield* forkBackground(
        sendRecoveryLink(
          profile.accountId,
          profile.email,
          opened.url,
          linkTtlMinutes,
          "first",
          sessionMeta,
        ),
      );
      metricRecoveryEmailBegin("resolved");
      return answer;
    }).pipe(withAuthRecovery("email_begin"));

  /**
   * `POST /login/recovery/email/:requestId/resend` — another link for the
   * same request, for the tab that holds its claim secret. Every link sent
   * stays usable until the request ends; at most `EMAIL_LINK_MAX_SENDS` in
   * all, each counted against the same limits as the first. Answers:
   *
   *  - `sent` — another link is on its way; also for an address with no
   *    account (nothing goes out), for a request its link's reader ended
   *    (nothing goes out), and for a request already confirmed (the next poll
   *    finishes it);
   *  - `limit` — the request has sent all the links it may;
   *  - `expired` — no live request matches.
   *
   * Like begin, it mails after the answer, and an address with no account
   * makes the same calls: the account is read on every branch, by a key that
   * names none. A link goes only to the address the request was begun for.
   */
  const resendEmailRecovery = (
    requestId: string,
    claimSecret: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { status: "sent" | "limit" | "expired" },
    DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const resent = yield* links.resend("recovery", requestId, claimSecret);
      if (resent.state === "expired") return EXPIRED;
      if (resent.state === "limit") return { status: "limit" } as const;
      if (resent.state === "confirmed") return { status: "sent" } as const;
      const profile = yield* findDefaultProfile(resent.subject);
      if (!resent.ended && profile && resent.bound === addressDigest(profile.email)) {
        const minutesLeft = Math.max(1, Math.ceil((resent.expiresAt - Date.now()) / 60_000));
        yield* logDevLink("recovery", resent.url);
        yield* forkBackground(
          sendRecoveryLink(
            profile.accountId,
            profile.email,
            resent.url,
            minutesLeft,
            "resend",
            sessionMeta,
          ),
        );
      }
      return { status: "sent" } as const;
    }).pipe(withAuthRecovery("email_resend"));

  /**
   * Hands the restricted recovery session to the caller — the tab that holds
   * the claim secret — for a confirmed request, or finishes a request an
   * earlier poll claimed and could not finish.
   *
   *  - The account must still have the address the link went to (`bound`).
   *  - The claim fixes the profile and the id of the `account_recovered` row
   *    every later try uses. Of two polls at once one claims the request; the
   *    other answers `expired`, as does a poll that finds it held by another.
   *  - The session is answered only once this poll has spent the request, so
   *    of all the polls that ever hold it exactly one delivers. A refusal
   *    (the cooldown, a default profile changed since the claim) spends it
   *    too. Any other failure keeps the claim and lets go of it, so the next
   *    poll takes over at once; a try after the recovery committed finds its
   *    own row and goes on to the session rather than meeting the cooldown.
   */
  const finishEmailRecovery = (
    requestId: string,
    link: EmailLinkChallenge,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    RecoveryEmailStatus,
    AuthError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const profile = yield* findDefaultProfile(link.subject);
      if (!profile || link.bound !== addressDigest(profile.email)) {
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }
      const claimed = yield* links.claim(requestId, link, {
        accountId: profile.accountId,
        profileId: profile.id,
        eventId: genId("sev_"),
      });
      if (!claimed) return EXPIRED;
      const { claim } = claimed;

      const done = yield* Effect.gen(function* () {
        if (claim.profileId !== profile.id || claim.eventId === undefined) {
          return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
        }
        const finished = yield* completeRecoveryFactor(profile, "otp", sessionMeta, claim.eventId);
        // Another poll took the request over and delivers it.
        if (!(yield* links.spend(requestId, claimed))) return null;
        return finished;
      }).pipe(
        Effect.tapError((e) =>
          (e._tag === "AuthError"
            ? links.spend(requestId, claimed)
            : links.letGo(requestId, claimed)
          ).pipe(Effect.ignore),
        ),
      );
      if (!done) return EXPIRED;
      return { status: "complete", session: done.session, profile: done.profile } as const;
    }).pipe(withAuthRecovery("email_complete"), withAuthLogin("email_recovery"));

  /**
   * `POST /login/recovery/email/:requestId/status` — polled by the tab that
   * began, with its claim secret. Answers `pending` until the link is
   * confirmed, with the request's number so a reloaded tab can show it again
   * without keeping it; then claims the request and answers `complete` with
   * the restricted recovery session, once. `expired` for every refusal: an
   * unknown, expired, declined or other-flow request, a wrong claim secret, a
   * poll that lost the claim to another or found another holding it, and a
   * recovery the cooldown refuses. A poll that fails after the claim leaves
   * the request claimed, and the next one finishes it.
   *
   * No attempts counter: a waiting tab polls every few seconds. The finishing
   * part counts as the recovery's `email_complete` step.
   */
  const emailRecoveryStatus = (
    requestId: string,
    claimSecret: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<RecoveryEmailStatus, DatabaseError | CoordinationError, Db | EmailService> =>
    Effect.gen(function* () {
      const polled = yield* links.poll("recovery", requestId, claimSecret);
      if (polled.state === "pending") {
        return polled.pairingCode === undefined
          ? ({ status: "pending" } as const)
          : ({ status: "pending", pairingCode: polled.pairingCode } as const);
      }
      if (polled.state === "expired") return EXPIRED;
      return yield* finishEmailRecovery(requestId, polled.entry, sessionMeta).pipe(
        Effect.catchTag("AuthError", () => Effect.succeed(EXPIRED)),
      );
    }).pipe(Effect.withSpan("auth.recovery.email_status"));

  /** When the account's `account_recovered` row `eventId` was written, or null for none. */
  const recoveryRowAt = (
    accountId: string,
    eventId: string,
  ): Effect.Effect<number | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ createdAt: securityEvents.createdAt })
            .from(securityEvents)
            .where(
              and(
                eq(securityEvents.id, eventId),
                eq(securityEvents.accountId, accountId),
                eq(securityEvents.kind, "account_recovered"),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows[0]?.createdAt ?? null;
    });

  /**
   * Everything both factors do once they have been believed: the emailed link
   * confirmed and claimed, or the authenticator code checked.
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
   *
   * `eventId`, from an emailed link's claim, names the `account_recovered` row
   * this recovery writes. A try that finds the cooldown running, that row
   * already written, and the account's last recovery still the instant that
   * row records is the same recovery, committed by an earlier try whose
   * session never went out: it skips the batch and goes on from that instant,
   * so its disown link names that recovery. It sets a disown token and sends
   * the notice again, since the earlier try may have failed before either.
   * Once any later recovery has stamped the account, the try is refused like
   * a second recovery.
   */
  const completeRecoveryFactor = (
    profile: ProfileWithEmail,
    amr: RecoveryFactorAmr,
    sessionMeta?: SessionMeta,
    eventId?: string,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError | CoordinationError,
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
      // `begin` to check. It costs the caller the factor they just proved,
      // which is the right way round — a refused recovery should not leave a
      // live link or code behind. Only a confirmed and claimed link, or a
      // checked code, reaches here, so the refusal is no oracle.
      //
      // `lastRecoveredAt` rides in on the profile, so this reads nothing: a
      // database hop inside the resolving branch alone would separate a real
      // account from a stranger's guess by latency, which is the oracle the
      // whole module is written to avoid.
      const previousRecovery = profile.lastRecoveredAt;
      let recoveredAt = nowSec;
      if (
        previousRecovery !== null &&
        Date.now() - previousRecovery * 1000 < RECOVERY_COOLDOWN_MS
      ) {
        // Read only for a confirmed and claimed email link that meets the
        // cooldown, past the link and its number, so this read is no oracle
        // either.
        const ownAt =
          eventId === undefined ? null : yield* recoveryRowAt(profile.accountId, eventId);
        if (ownAt === null || ownAt !== previousRecovery) {
          metricRecoveryCooldown("second_recovery_refused");
          return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
        }
        recoveredAt = ownAt;
      } else {
        const securityEventRow: typeof securityEvents.$inferInsert = {
          id: eventId ?? genId("sev_"),
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
      }

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
      yield* storeCall(stores.recoveryDisownTokens, "set", () =>
        stores.recoveryDisownTokens.set(
          disown.lookupId,
          {
            secretHash: hashSessionToken(disown.secret),
            accountId: profile.accountId,
            recoveredAt,
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
   * branch pays `burnTotpCheckCost` — the same attempt count, credential query
   * and dummy-key verification a real account pays for.
   */
  const completeTotpRecovery = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(identifier);

      if (!profile) {
        // Mirror the cost of the branch `checkTotpCode` would have taken —
        // written next to that function rather than here, so the two cannot
        // drift. It counts the attempt, runs the credential query and the
        // dummy-key verification against the caller's probe key, which names
        // no account; the count it leaves there expires with its window.
        yield* burnTotpCheckCost(code, serverMac.probeKey(normalised));
        return yield* Effect.fail(new AuthError({ message: GENERIC_FAILURE }));
      }

      yield* checkTotpCode(profile.accountId, code, "recovery");
      return yield* completeRecoveryFactor(profile, "totp", sessionMeta);
    }).pipe(withAuthRecovery("totp_complete"), withAuthLogin("totp_recovery"));

  /** What `POST /recovery/disown` answers, on every branch. */
  const DISOWN_ACCEPTED: RecoveryDisownAccepted = { status: "accepted" };

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
  ): Effect.Effect<RecoveryDisownAccepted, DatabaseError, Db> =>
    Effect.gen(function* () {
      const parsed = parseDisownToken(token);
      // A malformed token still pays for both hops, so "that was not even the
      // right shape" is not measurably cheaper than "that was wrong".
      const lookupId = parsed?.lookupId ?? genId("rdt_");

      // An unreadable store reads as `undefined`. The store has logged it.
      const entry = yield* storeCall(stores.recoveryDisownTokens, "get", () =>
        stores.recoveryDisownTokens.get(lookupId),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));

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
      // A claim the store could not make reads as `null`. The store has logged it.
      const claimed = yield* storeCall(stores.recoveryDisownTokens, "consume", () =>
        stores.recoveryDisownTokens.consume(lookupId),
      ).pipe(Effect.catch(() => Effect.succeed(null)));
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
            yield* storeCall(stores.recoveryDisownTokens, "set", () =>
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
    storeCall(stores.recoveryDisownTokens, "get", () =>
      stores.recoveryDisownTokens.get(genId("rdt_")),
    ).pipe(
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
              inArray(passkeys.id, jsonEachIn(revocable.map((row) => row.id))),
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
    emailRecoveryStatus,
    resendEmailRecovery,
    completeTotpRecovery,
    disownRecovery,
  };
}
