/**
 * Recovery codes (Copenhagen Book M2): single-use, high-entropy account
 * recovery tokens. Generation replaces the set atomically; consumption is
 * CAS-guarded, revokes every session, and records an audit row. O2 lockout:
 * repeated failures against a real account trip a per-account counter.
 */

import { accounts, recoveryCodes, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  generateRecoveryCodes as cryptoGenerateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@shared/crypto";
import { commitBatch } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import type { SecurityEventKind } from "@shared/observability/metrics";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import { RECOVERY_LOCKOUT_THRESHOLD } from "../../lib/recovery-lockout-store";
import {
  metricRecoveryCodeConsumed,
  metricRecoveryCodesGenerated,
  metricRecoveryLockout,
  metricSecurityEventNotified,
  metricSecurityEventNotifyDuration,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAuthLogin,
  withAuthRecovery,
} from "../../metrics";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genId, normaliseIdentifier, probeAccountId } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, PublicProfile, SessionMeta, TokenSet } from "./types";
import { toPublicProfile } from "./types";

export function createRecoveryModule(
  ctx: AuthContext,
  profiles: ProfilesModule,
  tokens: TokensModule,
) {
  const { config, recoveryLockoutStore, hashIp, serverMac } = ctx;
  const { resolveIdentifier } = profiles;
  const { issueTokens } = tokens;

  const generateRecoveryCodesForAccount = (
    accountId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ recoveryCodes: string[] }, DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const codes = cryptoGenerateRecoveryCodes(RECOVERY_CODE_COUNT);
      const nowSec = Math.floor(Date.now() / 1000);
      const rows = codes.map((code) => ({
        id: genId("rec_"),
        accountId,
        codeHash: hashRecoveryCode(code),
        usedAt: null,
        createdAt: nowSec,
      }));

      // M-PK1b: the recovery-code swap and the matching security_events row
      // commit together. If the audit write fails, the code swap rolls back
      // too — we never want codes in the DB that the account holder can't
      // see in their security banner.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "recovery_code_generate",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      yield* Effect.tryPromise({
        // Swap the code set + audit row atomically (batch on D1, sequential on
        // bun:sqlite) — never leave codes the account holder can't see.
        try: () =>
          commitBatch(db, [
            db.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
            db.insert(recoveryCodes).values(rows),
            db.insert(securityEvents).values(securityEventRow),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricRecoveryCodesGenerated();
      // S-L3 (symmetric): regenerating the set is a security-relevant event
      // worth surfacing on the session-invalidation dashboard. It doesn't
      // revoke sessions itself, but it does invalidate the previous code set
      // — an out-of-band regen (XSS-triggered, S-M1) is exactly the pattern
      // we want to notice.
      metricSessionSecurityInvalidation("recovery_code_generate");
      metricSecurityEventRecorded("recovery_code_generate");

      // M-PK1b / P-W2: fire-and-forget email notification. The audit row is
      // the primary signal, so user-visible latency must not track mailer
      // health. Fork onto the scheduler with a hard timeout so a slow
      // provider can't tie up the request handler. Failure is logged via
      // the metric branches inside `notifyRecovery`.
      yield* forkBackground(
        notifyRecoveryByAccountId(accountId, "recovery_code_generate").pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.void),
        ),
      );

      return { recoveryCodes: codes };
    }).pipe(withAuthRecovery("generate"));

  /**
   * Resolves the recipient email for a security-event notification from the
   * accounts table and dispatches via `notifyRecovery`. Used by the
   * fire-and-forget paths in generate/consume which don't already hold the
   * profile row. Stays out of the user's latency path (called inside
   * `Effect.forkDetach`), so the extra round-trip is harmless.
   */
  const notifyRecoveryByAccountId = (
    accountId: string,
    kind: SecurityEventKind,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const email = rows[0]?.email ?? null;
      yield* notifyRecovery(email, kind);
    });

  /**
   * Sends the out-of-band "your recovery codes were regenerated" OR "your
   * recovery codes were used" email. S-L5 framing ("somebody asked for this
   * on your account") mirrors the email-change ceremony so a misdirected
   * message is clearly junk to the recipient and useless as a phishing
   * template.
   *
   * Never includes the codes themselves — the audit row is the signal, the
   * email is the confirmation.
   *
   * P-I5: accepts the recipient email directly so the common call path
   * doesn't re-fetch the `accounts` row — the caller already has it.
   */
  const notifyRecovery = (
    recipientEmail: string | null,
    kind: SecurityEventKind,
  ): Effect.Effect<void, AuthError, EmailService> =>
    Effect.gen(function* () {
      if (!recipientEmail) {
        // Defensive: account row fully evicted between commit and dispatch.
        metricSecurityEventNotified(kind, "skipped");
        return;
      }

      const template =
        kind === "recovery_code_generate" ? "recovery-generated" : "recovery-consumed";
      const email = yield* EmailService;
      const start = Date.now();
      yield* email
        .send({ template, to: recipientEmail, data: { instanceName: config.instanceName } })
        // S-L2: bounded error class name in the log annotation; the email
        // provider's response body (which may echo the recipient) is never
        // embedded in the logged message.
        .pipe(
          Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
          Effect.tap(() =>
            Effect.sync(() => {
              metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
              metricSecurityEventNotified(kind, "sent");
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
              metricSecurityEventNotified(kind, "failed");
            }),
          ),
        );
    }).pipe(Effect.withSpan("auth.security_event.notify", { attributes: { kind } }));

  /**
   * Write the `recovery_code_lockout` audit row when an account crosses the
   * failed-attempt threshold. Surfaces in the security-events banner so the
   * legitimate owner sees "repeated failed recovery attempts on your account"
   * even though every attempt returned the same generic error over the wire.
   * Best-effort and off the response path: the caller forks it, so the
   * refusal never waits on it, and a write failure is logged, never answered.
   */
  const recordRecoveryLockoutEvent = (
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
            kind: "recovery_code_lockout",
            createdAt: nowSec,
            acknowledgedAt: null,
            ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
            uaLabel: eventMeta?.uaLabel ?? null,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(
        Effect.tap(() => Effect.sync(() => metricSecurityEventRecorded("recovery_code_lockout"))),
        Effect.catch((cause) =>
          Effect.logWarning("auth.recovery.lockout: audit write failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("auth.recovery.lockout"));

  /**
   * Consumes a recovery code — returns the profile to establish a fresh
   * session against, and marks the code row as used. Invalidates every
   * existing session for the account before the caller issues the new one.
   *
   * Always fails with the same generic AuthError on unknown identifier,
   * unknown/used code, or expired lookups — does not distinguish between
   * "wrong identifier" and "wrong code" over the wire.
   *
   * **Every refusal does the same work**, so it costs the same: the lockout
   * lookup, the conditional consume (`UPDATE … RETURNING`), then the
   * classification read and the failure record side by side — two store
   * round trips and
   * two `recovery_codes` statements of the same shape, whether the identifier
   * names nobody, names a locked account, or names an account and the code is
   * wrong. That is what a wrong code costs, and the most any refusal costs.
   * The branches that must not touch an account's codes or counter make the
   * same statements against a sentinel account id that matches no row, and
   * the same store calls at the caller's probe key, which reaches an object of
   * the same name shape and age as an account's. The audit row the threshold
   * guess writes is written after the answer.
   */
  const consumeRecoveryCode = (
    identifier: string,
    code: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ profile: ProfileWithEmail }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);
      const { db } = yield* Db;
      const probe = serverMac.probeKey(normalised);
      const nowSec = Math.floor(Date.now() / 1000);

      // Hashed up front on every branch, so each pays the same SHA-256.
      const codeHash = hashRecoveryCode(code);

      /**
       * Mark the code used ONLY while it is still unused, matched by
       * (accountId, codeHash), in one atomic statement: no window exists in
       * which two concurrent requests can both see the code as unused, on any
       * backend. RETURNING says whether a row was claimed.
       */
      const tryConsume = (accountId: string) =>
        Effect.tryPromise({
          try: () =>
            db
              .update(recoveryCodes)
              .set({ usedAt: nowSec })
              .where(
                and(
                  eq(recoveryCodes.accountId, accountId),
                  eq(recoveryCodes.codeHash, codeHash),
                  isNull(recoveryCodes.usedAt),
                ),
              )
              .returning({ id: recoveryCodes.id }),
          catch: (cause) => new DatabaseError({ cause }),
        });

      /** Whether the code exists and was used already — a replay — or never existed. */
      const classify = (accountId: string) =>
        Effect.tryPromise({
          try: () =>
            db
              .select({ usedAt: recoveryCodes.usedAt })
              .from(recoveryCodes)
              .where(
                and(eq(recoveryCodes.accountId, accountId), eq(recoveryCodes.codeHash, codeHash)),
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });

      /**
       * A wrong code's statements and failure record, touching nothing real:
       * the statements against a fresh random account id no row has (see
       * `probeAccountId`), the failure at the probe key. The classification
       * read and the failure record run side by side, as on the real branch.
       */
      const padRefusal = Effect.gen(function* () {
        const sentinel = probeAccountId();
        yield* tryConsume(sentinel);
        yield* Effect.all(
          [classify(sentinel), Effect.promise(() => recoveryLockoutStore.recordFailure(probe))],
          { concurrency: "unbounded", discard: true },
        );
      });

      if (!profile) {
        yield* Effect.promise(() => recoveryLockoutStore.status(probe));
        yield* padRefusal;
        metricRecoveryCodeConsumed("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      // Per-account lockout. Keyed on the RESOLVED accountId (never the
      // caller-supplied identifier) so an attacker cannot lock a victim out by
      // spamming their handle, and an unknown identifier can never trip one.
      // A locked account must never consume a code, so it pays the padded
      // refusal and answers the SAME generic error: a locked account is
      // indistinguishable from a wrong code.
      //
      // A counter that cannot be read (`"unknown"`) takes the same path: an
      // attempt there could not be counted, so the code is never touched — the
      // owner retries once the store answers again — and no security event is
      // written, since nothing is known to have crossed the threshold.
      const lockout = yield* Effect.promise(() => recoveryLockoutStore.status(profile.accountId));
      if (lockout.status !== "open") {
        yield* padRefusal;
        metricRecoveryLockout(lockout.status === "locked" ? "locked" : "unavailable");
        metricRecoveryCodeConsumed("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const consumedRows = yield* tryConsume(profile.accountId);

      if (consumedRows.length === 0) {
        // A genuine failed attempt against a real account — record it and trip
        // the lockout (and its audit row) on the attempt that crosses the
        // threshold. Both "wrong code" and "already-used code" count; the
        // read-only follow-up classifies which for the metric and the replay
        // log (a concurrent double-consume loser lands here as "used" too).
        // Neither the classification nor the failure record waits on the
        // other, so they run side by side.
        const [replayRows, attempts] = yield* Effect.all(
          [
            classify(profile.accountId),
            Effect.promise(() => recoveryLockoutStore.recordFailure(profile.accountId)),
          ],
          { concurrency: "unbounded" },
        );
        if (replayRows[0] && replayRows[0].usedAt !== null) {
          yield* Effect.logWarning("Used recovery code replayed");
          metricRecoveryCodeConsumed("used");
        } else {
          metricRecoveryCodeConsumed("invalid");
        }
        if (attempts === "unknown") {
          // Not counted, so not known to have crossed the threshold: no event.
          metricRecoveryLockout("unavailable");
        } else if (attempts === RECOVERY_LOCKOUT_THRESHOLD) {
          // After the answer: only a real account crosses the threshold, so a
          // refusal that waited on this insert would tell a stopwatch so.
          yield* forkBackground(recordRecoveryLockoutEvent(profile.accountId, eventMeta));
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      // S-H1: a recovery-code CONSUME is the actual takeover step in the
      // attacker-burns-codes scenario. Record the audit row in the same
      // transaction as the sessions wipe so the legitimate owner can see
      // "a recovery code was used on your account" even if the attacker
      // suppressed the confirmation email.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId: profile.accountId,
        kind: "recovery_code_consume",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      yield* Effect.tryPromise({
        // The code is now ours. Wipe sessions + write the audit row atomically
        // (batch on D1, sequential on bun:sqlite). Recovery always revokes
        // existing sessions — the ceremony is "I lost access, log me back in
        // cleanly everywhere".
        try: () =>
          commitBatch(db, [
            db.delete(sessions).where(eq(sessions.accountId, profile.accountId)),
            db.insert(securityEvents).values(securityEventRow),
            // Stamp the recovery window. This path is never REFUSED by the
            // window it opens — a recovery code is a 64-bit secret the user was
            // handed once, and capping it would shut the owner's only
            // unauthenticated door for three days, which is the one door a
            // mailbox holder cannot open. But the window still has to start
            // here, or a recovery-code login would leave the email-change gate
            // and the passkey-provenance comparison measuring from nothing.
            db
              .update(accounts)
              .set({ lastRecoveredAt: nowSec })
              .where(eq(accounts.id, profile.accountId)),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricRecoveryCodeConsumed("success");
      // A successful consume takes back the failures the lookup above
      // counted — after the answer, since the answer does not depend on it,
      // and only when there are any. A failure a wrong code records after that
      // lookup, before or after the answer, stands, and expires with its
      // window.
      if (lockout.failures > 0) {
        yield* forkBackground(
          Effect.promise(() => recoveryLockoutStore.reset(profile.accountId, lockout.failures)),
        );
        metricRecoveryLockout("reset");
      }
      // S-L3: whole-account session wipe is a security-relevant event — emit
      // the canonical invalidation metric so the existing dashboard covers it.
      metricSessionSecurityInvalidation("recovery_code_consume");
      metricSecurityEventRecorded("recovery_code_consume");

      // M-PK1b / P-W2: fire-and-forget consume notification with a timeout
      // so the login latency is decoupled from mailer health. The profile
      // is already loaded so we pass the email directly — no post-commit
      // accounts round-trip.
      yield* forkBackground(
        notifyRecovery(profile.email, "recovery_code_consume").pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.void),
        ),
      );

      return { profile };
    }).pipe(withAuthRecovery("consume"));

  /**
   * Completes a recovery-code login. Consumes the code, then issues a fresh
   * session + profile in one step so the route can return the same shape as
   * the other first-party `/login/*` completers.
   */
  const completeRecoveryLogin = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const { profile } = yield* consumeRecoveryCode(identifier, code, sessionMeta);
      const session = yield* issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        sessionMeta,
      );
      return { session, profile: toPublicProfile(profile, profile.email) };
    }).pipe(withAuthLogin("recovery_code"));

  /**
   * Returns the count of unused recovery codes for the account, plus when the
   * current set was minted (`generatedAt`, unix seconds, null when the account
   * has never generated a set). Generation replaces the whole set atomically,
   * so the newest `created_at` dates the set as a whole.
   */
  const countActiveRecoveryCodes = (
    accountId: string,
  ): Effect.Effect<
    { active: number; total: number; generatedAt: number | null },
    DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // P-I1: SQL aggregate instead of SELECTing full rows (including the
      // secret-bearing code_hash) just to take lengths in JS.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              active: sql<number>`sum(case when ${recoveryCodes.usedAt} is null then 1 else 0 end)`,
              total: sql<number>`count(*)`,
              generatedAt: sql<number | null>`max(${recoveryCodes.createdAt})`,
            })
            .from(recoveryCodes)
            .where(eq(recoveryCodes.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // SUM over zero rows is NULL — coalesce both to 0 for empty accounts.
      const generatedAt = rows[0]?.generatedAt;
      return {
        active: Number(rows[0]?.active ?? 0),
        total: Number(rows[0]?.total ?? 0),
        generatedAt: generatedAt == null ? null : Number(generatedAt),
      };
    });

  return {
    generateRecoveryCodesForAccount,
    notifyRecovery,
    notifyRecoveryByAccountId,
    consumeRecoveryCode,
    completeRecoveryLogin,
    countActiveRecoveryCodes,
  };
}

export type RecoveryModule = ReturnType<typeof createRecoveryModule>;
