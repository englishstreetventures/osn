/**
 * Passkey ceremonies: registration begin/complete (step-up gated past the
 * first credential) and login begin/complete, including the discoverable
 * (conditional-UI) flow and the shared assertion verifier.
 */

import {
  accounts,
  type NewPasskey,
  passkeys,
  securityEvents,
  sessions,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import {
  classifyError,
  metricPasskeyLoginDiscoverable,
  metricRecoveryPasskeyReclaim,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAuthLogin,
} from "../../metrics";
import {
  CHALLENGE_TTL_MS,
  MAX_PASSKEYS_PER_ACCOUNT,
  PASSKEY_LAST_USED_COALESCE_MS,
  RECOVERY_ENROLMENT_PASSKEY_CEILING,
} from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genId, normaliseIdentifier, now, probeAccountId } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { SecurityEventsModule } from "./security-events";
import type { SessionsModule } from "./sessions";
import type { StepUpModule } from "./step-up";
import type { TokensModule } from "./tokens";
import type {
  PasskeyProvenance,
  ProfileWithEmail,
  PublicProfile,
  SessionMeta,
  TokenSet,
} from "./types";
import { toPublicProfile } from "./types";

// Hoisted — a TextEncoder is stateless, so one module-level instance
// serves every registration ceremony instead of allocating per call.
const textEncoder = new TextEncoder();

export function createPasskeysModule(
  ctx: AuthContext,
  profiles: ProfilesModule,
  tokens: TokensModule,
  sessions_: SessionsModule,
  stepUp: StepUpModule,
  securityEventsModule: SecurityEventsModule,
) {
  const { config, stores, hashIp, passkeyRegisterAllowedAmr } = ctx;
  const { resolveIdentifier, findDefaultProfile } = profiles;
  const { issueTokens, liftSessionRestriction } = tokens;
  const { invalidateOtherAccountSessions } = sessions_;
  const { verifyStepUpForPasskeyRegister } = stepUp;
  /** See {@link SecurityEventsModule.notifySecurityEventByAccountId}. */
  const notifyPasskeyRegisteredByAccountId = (accountId: string) =>
    securityEventsModule.notifySecurityEventByAccountId(
      accountId,
      "passkey_register",
      "passkey-added",
      {},
    );

  /**
   * Whether a restricted recovery session may enrol past the step-up gate.
   *
   * The bypass rests on the ceremony that minted the session — an email OTP or
   * a TOTP code at a strength `passkeyRegisterAllowedAmr` admits — so it is
   * decided by the factor recorded on the session row, never by the token's
   * audience. Four ways to answer no, all of them fail-closed: the row is not
   * this account's, is not restricted, records no factor, or records one
   * outside the allow-list. The deadline is checked too, because
   * `liveSessionIds` (which is how the route names this session) has no expiry
   * term of its own.
   */
  const recoverySessionAdmitsEnrolment = (
    accountId: string,
    sessionHash: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              restrictedUntil: sessions.restrictedUntil,
              restrictedAmr: sessions.restrictedAmr,
            })
            .from(sessions)
            .where(and(eq(sessions.id, sessionHash), eq(sessions.accountId, accountId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row || row.restrictedUntil === null || row.restrictedAmr === null) return false;
      if (row.restrictedUntil <= Math.floor(Date.now() / 1000)) return false;
      return passkeyRegisterAllowedAmr.has(row.restrictedAmr);
    });

  const beginPasskeyRegistration = (
    accountId: string,
    /**
     * Required when the account already has ≥1 passkey. First-
     * credential enrollment (bootstrap) bypasses the gate — no step-up
     * ceremony is reachable before the account has any authenticators.
     * Verified below after the existingPasskeys read.
     */
    stepUpToken?: string,
    /**
     * The hashed id of the caller's own **restricted recovery session**, set
     * only when `resolvePasskeyEnrollPrincipal` accepted the `osn-recovery`
     * audience and the route could name the session behind it (from the cookie
     * or the token's `osn_sid`). It can take the caller past the step-up gate
     * below, deliberately: losing a phone does not delete its passkey row, so
     * the account almost always still has ≥1 credential and the gate would make
     * recovery impossible in exactly the case recovery is for.
     *
     * A hash is a request, not a grant. `recoverySessionAdmitsEnrolment`
     * decides, on the factor the session row records — so the bypass is worth
     * exactly what the ceremony behind the session was worth, and an
     * unresolvable or inadmissible session simply falls back to needing a
     * step-up token.
     *
     * The alternative — letting a restricted session mint step-up tokens —
     * would open `/recovery/generate`, `DELETE /account`, `GET /account/export`
     * and `/account/email/complete` along with it.
     *
     * The per-account passkey cap does NOT refuse this enrolment — a refusal
     * here is an account nobody can reach again. `complete` reclaims what this
     * recovery episode itself lent instead, which is what keeps the count from
     * ratcheting; see `RECOVERY_ENROLMENT_PASSKEY_CEILING`. Every other caller
     * is refused at the cap unchanged.
     */
    caller?: { readonly recoverySessionHash: string },
  ): Effect.Effect<
    { options: PublicKeyCredentialCreationOptionsJSON },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // Look up the account row (for passkeyUserId) and default profile (for display name)
      const [accountResult, profileResult, existingPasskeys] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () => db.select().from(users).where(eq(users.accountId, accountId)).limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, accountId)),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );
      const account = accountResult[0];
      const profile = profileResult[0];
      if (!account || !profile) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }

      // Whether the restricted-recovery-session bypass applies. Resolved BEFORE
      // the cap check, because whether the cap applies at all depends on it —
      // and resolving it costs one indexed read of the caller's own session row,
      // never a single-use token, so hoisting it above the cap preserves the
      // property the ordering exists for: a capped user must not burn a step-up
      // for nothing.
      const recoveryEnrolment =
        caller && existingPasskeys.length > 0
          ? yield* recoverySessionAdmitsEnrolment(accountId, caller.recoverySessionHash)
          : false;

      // Refuse to mint options past the per-account cap. Checked
      // BEFORE the step-up gate so a user who's already at the cap
      // doesn't burn a single-use step-up token for nothing.
      //
      // A recovery-session enrolment is not held to the cap at all, and is not
      // refused at any count. An account that has lost every device cannot enrol
      // past the cap and cannot delete to make room — `passkeyDeleteAllowedAmr`
      // is WebAuthn-only and a restricted session cannot mint a step-up — so a
      // count-based refusal here is an account nobody can reach again. What
      // bounds the count instead is the reclaim in `complete`, which takes back
      // the slots THIS recovery episode lent; and what bounds the growth when
      // there is nothing of its own to take back is the recovery cooldown, one
      // episode per RECOVERY_COOLDOWN_MS.
      if (!recoveryEnrolment && existingPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return yield* Effect.fail(
          new AuthError({ message: "Passkey limit reached for this account" }),
        );
      }

      // Once the account has any passkey, adding another requires a
      // fresh step-up token. A stolen access token alone cannot bind a
      // new authenticator. A restricted recovery session whose recorded factor
      // the register allow-list admits is the one exception — see
      // `caller.recoverySessionHash` above.
      // What the credential this ceremony produces will be stamped with.
      //
      // A bootstrap enrolment is `webauthn`: it is the account's root of trust,
      // and there is nothing older for it to be weaker than. Stamping it from
      // the registration OTP would taint every credential the account ever
      // derives from it, because provenance is inherited — ordinary rotation
      // would never become possible.
      let provenanceAmr: PasskeyProvenance = "webauthn";
      if (existingPasskeys.length > 0) {
        if (recoveryEnrolment) {
          // The restricted-recovery-session bypass: no step-up ran at all, so
          // no ceremony of the account's own stands behind this credential.
          provenanceAmr = "recovery";
        } else {
          if (!stepUpToken) {
            return yield* Effect.fail(new AuthError({ message: "Step-up required" }));
          }
          provenanceAmr = yield* verifyStepUpForPasskeyRegister(accountId, stepUpToken);
        }
      }

      const options = yield* Effect.tryPromise({
        try: () =>
          generateRegistrationOptions({
            rpName: config.rpName,
            rpID: config.rpId,
            userID: textEncoder.encode(account.passkeyUserId),
            userName: `@${profile.handle}`,
            userDisplayName: profile.displayName ?? `@${profile.handle}`,
            attestationType: "none",
            excludeCredentials: existingPasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            })),
            // `residentKey: "preferred"` admits FIDO2 security keys without
            // a resident-key slot (they register as non-discoverable and
            // still work for identified login). `userVerification: "required"`
            // keeps the factor strength at "something you have + something
            // you are/know" — obsolete UP-only U2F tokens cannot register,
            // which is intentional: they would subsequently fail the
            // verifier's `requireUserVerification: true` anyway (options
            // and verify must agree).
            authenticatorSelection: {
              residentKey: "preferred",
              userVerification: "required",
            },
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      yield* Effect.promise(() =>
        stores.registrationChallenges.set(
          accountId,
          {
            challenge: options.challenge,
            expiresAt: Date.now() + CHALLENGE_TTL_MS,
            // Decided here because this is where the step-up is verified and
            // where the recovery bypass is granted; written at `complete`,
            // where the row exists. The entry is how it travels.
            provenanceAmr,
            // Which cap `complete` holds the ceremony to. Trusted there without
            // re-reading the session row, and bounded by the two deadlines that
            // already bracket this ceremony: the challenge's own CHALLENGE_TTL_MS
            // and the restricted session's 15-minute absolute expiry.
            recoveryEnrolment,
          },
          CHALLENGE_TTL_MS,
        ),
      );

      return { options };
    });

  // -------------------------------------------------------------------------
  // Passkey: complete registration
  // -------------------------------------------------------------------------

  const completePasskeyRegistration = (
    accountId: string,
    attestation: RegistrationResponseJSON,
    /**
     * Hashed session id of the caller, so all OTHER sessions for this
     * account can be revoked (H1) while the caller survives. The route
     * resolves it via `resolveCallerSession` — from the HttpOnly cookie
     * when one names a live row, otherwise from the access token's
     * `osn_sid` binding. Either way it is server-derived, never
     * user-supplied body input, so an attacker holding only an access
     * token cannot skip H1 invalidation by omitting a field.
     */
    callerSessionHash: string | null,
    /** IP + UA for the security_events row. Best-effort; omitted in tests. */
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ passkeyId: string }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() => stores.registrationChallenges.get(accountId));
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      yield* Effect.promise(() => stores.registrationChallenges.delete(accountId));

      const verification = yield* Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            response: attestation,
            expectedChallenge: entry.challenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpId,
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      if (!verification.verified || !verification.registrationInfo) {
        return yield* Effect.fail(new AuthError({ message: "Passkey registration not verified" }));
      }

      // Library-version-tolerant read of the optional WebAuthn fields. The
      // bounded fields (id/publicKey/counter/transports) are stable across
      // @simplewebauthn/server versions; aaguid + backup flags moved around
      // between majors and we don't want the build to pin to a point release.
      const info = verification.registrationInfo as typeof verification.registrationInfo & {
        aaguid?: string;
        credentialBackedUp?: boolean;
        credentialDeviceType?: "singleDevice" | "multiDevice";
      };
      const aaguid = typeof info.aaguid === "string" ? info.aaguid : null;
      const backedUp = info.credentialBackedUp ?? null;
      const eligible = info.credentialDeviceType === "multiDevice";
      const { db } = yield* Db;
      const id = genId("pk_");
      const ts = now();
      const nowSec = Math.floor(ts.getTime() / 1000);

      // Write the audit row in the SAME transaction as the passkey
      // insert so a signed-out attacker who skips the notification path
      // still leaves a row in security_events for the user to discover.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "passkey_register",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      // An entry parked by a deploy older than the flag carries no answer.
      // Read it as `false` — the ordinary cap, which is the restrictive one.
      const recoveryEnrolment = entry.recoveryEnrolment ?? false;

      // Cap enforcement. `beginPasskeyRegistration` already refuses
      // past the limit; this is the belt-and-braces check. D1 has no interactive
      // transaction, so the count read runs first and the passkey + audit insert
      // commit as one atomic batch. A pair of completes racing the cap could
      // exceed it by one — a benign over-count, not a security exposure (the
      // begin-side check is the primary guard).
      const passkeyCount = yield* Effect.tryPromise({
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

      // Which credentials, if any, this enrolment pays for its slot with.
      //
      // Decided HERE rather than replayed from `begin`: the two reads are up to
      // CHALLENGE_TTL_MS apart, and in between the account can gain or lose
      // credentials on paths this ceremony knows nothing about. The counter is
      // emitted from this decision alone, so one ceremony counts once.
      //
      // A candidate is a credential THIS RECOVERY EPISODE lent: `recovery`
      // provenance AND created at or after `accounts.last_recovered_at`, which
      // the recovery that minted this session stamped. Nothing that predates the
      // recovery is ever taken, and that is the whole rule.
      //
      // Provenance alone is not enough, and the difference is the security
      // property. `provenance_amr` is stamped at insert and never updated, so a
      // `recovery` row keeps that value for the life of the account — long after
      // the restriction it names has expired and the credential has become the
      // owner's real, daily device. Worse, the cooldown puts the earliest second
      // recovery at the moment the first lent credential matures, so a
      // provenance-only filter meets exactly one candidate in the case that
      // actually occurs: the matured one. Deleting it hands a mailbox-only
      // attacker the owner's last working credential, with no step-up presented
      // anywhere. The episode bound is what refuses that, and it mirrors W2 in
      // `step-up.ts`: a recovery may act on what it produced, not on what it
      // found.
      //
      // A NULL `last_recovered_at` yields no candidates at all. That is the
      // fail-closed answer: with no recorded recovery there is nothing this
      // episode can prove it lent.
      let reclaimIds: readonly string[] = [];
      if (recoveryEnrolment) {
        const surplus = passkeyCount.length + 1 - RECOVERY_ENROLMENT_PASSKEY_CEILING;
        if (surplus > 0) {
          const [account] = yield* Effect.tryPromise({
            try: () =>
              db
                .select({ lastRecoveredAt: accounts.lastRecoveredAt })
                .from(accounts)
                .where(eq(accounts.id, accountId))
                .limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          });
          const recoveredAt = account?.lastRecoveredAt ?? null;
          const candidates =
            recoveredAt === null
              ? []
              : passkeyCount
                  .filter(
                    (pk) =>
                      pk.provenanceAmr === "recovery" &&
                      Math.floor(pk.createdAt.getTime() / 1000) >= recoveredAt,
                  )
                  // `created_at` is unix seconds, so rows written in the same
                  // second tie. `id` breaks the tie deterministically — it is
                  // random, not monotonic, so it orders nothing by time; two tied
                  // rows are from the same instant and either is equally safe to
                  // take. Newest first among what is left, which are all rows
                  // this one episode lent.
                  .toSorted(
                    (a, b) =>
                      b.createdAt.getTime() - a.createdAt.getTime() ||
                      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                  );
          reclaimIds = candidates.slice(0, surplus).map((pk) => pk.id);
        }
        // Never a refusal. Where the surplus cannot be paid for, the threshold
        // gives way and the account ends above it — because the alternative is
        // taking a credential that may be the only one the owner can still use,
        // and the alternative to THAT is an account nobody can reach, which is
        // the failure this whole path exists to remove. What bounds the growth
        // is the cooldown: one episode, and so at most one unpaid credential,
        // per RECOVERY_COOLDOWN_MS.
        metricRecoveryPasskeyReclaim(
          surplus <= 0
            ? "headroom_used"
            : reclaimIds.length === surplus
              ? "reclaimed"
              : "ceiling_yielded",
        );
      } else if (passkeyCount.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return yield* Effect.fail(
          new AuthError({ message: "Passkey limit reached for this account" }),
        );
      }

      // The reclaim rides in the SAME batch as the insert that pays for it, so
      // no interleaving leaves the account one credential down. No survivor-count
      // guard is needed the way `revokeDisownedRecovery` needs one: this deletes
      // n and inserts 1 together, n never exceeds the surplus over the ceiling,
      // and it fires only when there IS a surplus — so the account lands on the
      // ceiling at worst, and the "≥1 passkey" invariant holds by construction
      // rather than by check.
      const reclaimStatements: BatchItem<"sqlite">[] =
        reclaimIds.length > 0
          ? [
              db
                .delete(passkeys)
                .where(and(eq(passkeys.accountId, accountId), inArray(passkeys.id, reclaimIds))),
              db.insert(securityEvents).values({
                id: genId("sev_"),
                accountId,
                kind: "passkey_reclaimed",
                createdAt: nowSec,
                acknowledgedAt: null,
                ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
                uaLabel: eventMeta?.uaLabel ?? null,
              }),
            ]
          : [];

      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            ...reclaimStatements,
            db.insert(passkeys).values({
              id,
              accountId,
              credentialId: info.credential.id,
              publicKey: Buffer.from(info.credential.publicKey).toString("base64"),
              counter: info.credential.counter,
              transports: info.credential.transports
                ? JSON.stringify(info.credential.transports)
                : null,
              createdAt: ts,
              label: null,
              // An entry parked before this column existed carries no
              // provenance. Stamp the most restrictive value rather than
              // failing a ceremony the user is halfway through: a credential
              // that waits 72 hours is a nuisance, one that cannot be
              // registered at all during a rolling deploy is an outage.
              provenanceAmr: entry.provenanceAmr ?? "recovery",
              lastUsedAt: null,
              aaguid,
              backupEligible: eligible,
              backupState: backedUp,
              updatedAt: nowSec,
            }),
            db.insert(securityEvents).values(securityEventRow),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricSecurityEventRecorded("passkey_register");
      if (reclaimIds.length > 0) {
        metricSecurityEventRecorded("passkey_reclaimed");
      }

      // Invalidate all other sessions on passkey registration.
      // An attacker who stole a session token cannot persist after the
      // legitimate user adds a passkey.
      //
      // The caller's own session comes from the cookie when one names a live
      // row, and otherwise from the access token's `osn_sid` binding — a
      // cross-origin Bearer call, a cookie-stripping proxy or a native client
      // all land on the second path and must NOT be treated as sessionless.
      // Enrolling a passkey is the one thing a restricted recovery session can
      // do, and the user has just done it — so the restriction is lifted here
      // and the caller's session becomes an ordinary one. A no-op on every
      // other session, and on the branch below where there is no caller session
      // to keep. From the next `/token` grant onward the access token carries
      // the ordinary audience again.
      yield* liftSessionRestriction(accountId, callerSessionHash);

      if (callerSessionHash) {
        yield* invalidateOtherAccountSessions(accountId, callerSessionHash);
      } else {
        // The caller has no identifiable session at all — no cookie, and
        // either no `osn_sid` in the access token or one that matches no live
        // session row. Previously this branch was a silent no-op — H1
        // invalidation was skipped entirely, so a stolen session survived the
        // very enrolment that is supposed to evict it. Nuke EVERY session on
        // the account (there is genuinely no "self" to preserve), log the
        // anomaly out-of-band, and emit the canonical invalidation metric so
        // the H1 dashboard still records the event.
        yield* Effect.logWarning("auth.passkey.register: nuking all sessions (no caller session)");
        yield* Effect.tryPromise({
          try: () => db.delete(sessions).where(eq(sessions.accountId, accountId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricSessionSecurityInvalidation("passkey_register");
      }

      // Best-effort email notification. Forked daemon — failure
      // logged but never rolls back the enrolment. 10s timeout matches
      // passkey_delete / recovery_code_* paths.
      yield* forkBackground(
        notifyPasskeyRegisteredByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.void),
        ),
      );

      // A credential vanished that the account holder never asked to lose, so
      // they are told separately from the one that was added. The
      // `passkey-removed` copy — "it was you, or investigate" — is the right
      // words here rather than a reuse of convenience: whoever reads this did
      // not perform the removal, and investigating is exactly what they should
      // do if the recovery behind it was not theirs.
      if (reclaimIds.length > 0) {
        yield* forkBackground(
          securityEventsModule
            .notifySecurityEventByAccountId(accountId, "passkey_reclaimed", "passkey-removed", {})
            .pipe(
              Effect.timeout("10 seconds"),
              Effect.catch(() => Effect.void),
            ),
        );
      }

      return { passkeyId: id };
    });

  // -------------------------------------------------------------------------
  // Passkey: begin login
  // -------------------------------------------------------------------------

  /**
   * M-PK: passkey login `begin` supports two flows:
   *
   *  1. **Identifier-bound** (legacy + explicit). The caller knows which
   *     account they want and supplies the handle or email. We look up the
   *     account's credentials and seed `allowCredentials` so the browser
   *     can filter its authenticator list. Challenge is keyed by the
   *     normalised identifier.
   *
   *  2. **Discoverable** (`identifier === null`). The caller has no
   *     identity up-front — conditional-UI autofill drives the ceremony,
   *     and the authenticator picks the credential. We emit options with
   *     an empty `allowCredentials` (forcing discoverable-credential
   *     resolution on the device) and key the challenge by a random
   *     `challengeId` that the client must round-trip to `complete`.
   *
   * Discoverable flow uses a short-lived random UUID as the challenge
   * key so two concurrent discoverable `begin`s don't collide. The raw
   * WebAuthn challenge is still a cryptographic nonce inside the
   * ceremony; `challengeId` is just the server-side map key.
   */
  const beginPasskeyLogin = (
    identifier: string | null,
  ): Effect.Effect<
    {
      options: PublicKeyCredentialRequestOptionsJSON;
      challengeId?: string;
    },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      // Discoverable path — no identifier. Emit options with empty
      // allowCredentials so the authenticator resolves via resident keys.
      if (identifier === null) {
        const options = yield* Effect.tryPromise({
          try: () =>
            generateAuthenticationOptions({
              rpID: config.rpId,
              allowCredentials: [],
              userVerification: "required",
            }),
          catch: (cause) => new AuthError({ message: String(cause) }),
        });
        // The store self-bounds (CEREMONY_STORE_MAX in-memory, native PX
        // expiry on Redis) and sweeps expired entries on insert, so no
        // separate size-cap check is needed.
        const challengeId = crypto.randomUUID();
        yield* Effect.promise(() =>
          stores.loginChallenges.set(
            `__disc__:${challengeId}`,
            { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS },
            CHALLENGE_TTL_MS,
          ),
        );
        return { options, challengeId };
      }

      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);

      // Resolve passkeys for the account when the identifier is known, or
      // nothing when it isn't. Both branches run a DB SELECT so the query
      // latency distribution is the same (no timing oracle).
      const { db } = yield* Db;
      const profilePasskeys = profile
        ? yield* Effect.tryPromise({
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, profile.accountId)),
            catch: (cause) => new DatabaseError({ cause }),
          })
        : yield* Effect.tryPromise({
            // Burn-in query: hit the table with a never-matching accountId
            // so an unknown identifier costs the same shape of work as a
            // known one. Random per-request sentinel — see probeAccountId.
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, probeAccountId())),
            catch: (cause) => new DatabaseError({ cause }),
          });

      // Equalise the response envelope. Unknown identifier AND
      // known-with-zero-passkeys return a single fabricated credentialId;
      // known-with-passkeys returns the real allowCredentials. The wire
      // shape — `{ options: { …, allowCredentials: [...], userVerification } }`
      // — is identical in all three cases, so an anonymous caller can no
      // longer probe the handle/email namespace through this endpoint.
      // The "≥1 passkey" account invariant means the no-passkey branch is
      // only reachable for legacy/corrupt data; it collapses into the
      // unknown-identifier branch for free.
      const realCredentials =
        profile && profilePasskeys.length > 0
          ? profilePasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            }))
          : null;
      const allowCredentials = realCredentials ?? [
        {
          // Random bytes base64url-encoded — never corresponds to a real
          // credential. A subsequent `/login/passkey/complete` with an
          // assertion for this id will fail at the challenge lookup
          // because we do NOT persist a challenge for the synthetic
          // branch.
          id: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        },
      ];

      const options = yield* Effect.tryPromise({
        try: () =>
          generateAuthenticationOptions({
            rpID: config.rpId,
            allowCredentials,
            // `verifyAuthenticationResponse` sets
            // `requireUserVerification: true`, so options and verify must
            // agree. "required" here matches the verifier, matches the
            // identifier-less flow, and makes the ceremony phishing-
            // resistant with a second factor (UV) — the whole point of
            // passkey-primary. Registration only admits UV-capable
            // credentials, so this does not regress legitimate sign-ins.
            userVerification: "required",
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      // Key challenge by normalised identifier so completePasskeyLoginDirect
      // can check the in-memory guard before touching the DB. Skip the
      // write on the synthetic branch: a subsequent complete call hits the
      // "challenge not found" guard, which is indistinguishable from a
      // legitimate timeout — preserves the enumeration safety into
      // the complete step too.
      if (realCredentials) {
        // Store self-bounds + self-sweeps (see discoverable branch above).
        yield* Effect.promise(() =>
          stores.loginChallenges.set(
            normalised,
            { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS },
            CHALLENGE_TTL_MS,
          ),
        );
      }

      return { options };
    }).pipe(Effect.withSpan("auth.login.passkey.begin"));

  // -------------------------------------------------------------------------
  // Passkey: verify assertion (extracted so both the code-issuing and
  // direct-session completion paths can share the same WebAuthn verification
  // logic without duplication).
  // -------------------------------------------------------------------------

  /**
   * Input for the shared passkey-assertion verifier. Exactly one of
   * `identifier` or `challengeId` is present — the route layer validates
   * that invariant before dispatching.
   */
  type PasskeyLoginContext =
    | { kind: "identified"; identifier: string }
    | { kind: "discoverable"; challengeId: string };

  const verifyPasskeyAssertion = (
    context: PasskeyLoginContext,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<ProfileWithEmail, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Resolve challenge key before any DB lookup.
      const challengeKey =
        context.kind === "identified"
          ? normaliseIdentifier(context.identifier)
          : `__disc__:${context.challengeId}`;
      const entry = yield* Effect.promise(() => stores.loginChallenges.get(challengeKey));
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      yield* Effect.promise(() => stores.loginChallenges.delete(challengeKey));

      const { db } = yield* Db;
      // Look up the credential row by `credentialId` — stable across both
      // flows. For the identified flow we also verify the credential belongs
      // to the claimed account (prevents a valid assertion for credential X
      // from signing in account Y).
      const pkResult = yield* Effect.tryPromise({
        try: () =>
          db.select().from(passkeys).where(eq(passkeys.credentialId, assertion.id)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const pk = pkResult[0];
      if (!pk) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      let profile: ProfileWithEmail | null;
      if (context.kind === "identified") {
        // P-I5b: the identifier lookup below is load-bearing (it selects the
        // profile to log into AND anchors the accountId binding check), but
        // the separate `accounts` row read is not — `resolveIdentifier`
        // inner-joins accounts, so a matching profile with
        // `profile.accountId === pk.accountId` proves the passkey's account
        // exists. The account row itself is only needed by the discoverable
        // branch (userHandle pin), so it is fetched there.
        const normalised = normaliseIdentifier(context.identifier);
        profile = yield* resolveIdentifier(normalised);
        if (!profile || profile.accountId !== pk.accountId) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
      } else {
        // Look up the owning account — needed for the discoverable-flow
        // userHandle pin below.
        const accountRow = yield* Effect.tryPromise({
          try: () => db.select().from(accounts).where(eq(accounts.id, pk.accountId)).limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        const account = accountRow[0];
        if (!account) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
        // Discoverable flow — the credential row supplies the account.
        // Cross-check the assertion's `userHandle` against the account's
        // stored `passkeyUserId`. The signature already binds the assertion
        // to the credential, so this is defence-in-depth: if a future schema
        // change ever lets a credentialId map to two accounts, the
        // userHandle pin still prevents account A's credential from logging
        // into account B.
        const userHandle = assertion.response.userHandle;
        if (typeof userHandle !== "string" || userHandle.length === 0) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
        // userHandle is base64url-encoded by the browser. The stored
        // passkeyUserId is the raw UTF-8 string we passed to
        // generateRegistrationOptions, so decode + compare.
        const decodedHandle = Buffer.from(userHandle, "base64url").toString("utf8");
        if (decodedHandle !== account.passkeyUserId) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
        profile = yield* findDefaultProfile(pk.accountId);
        if (!profile) {
          return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
        }
      }

      // Never reflect the WebAuthn library's error text to the caller —
      // it can pinpoint failure mode (challenge mismatch vs origin mismatch
      // vs counter regression) and lets an attacker probe the verifier. We
      // log the cause for operators (annotation goes through the redaction
      // logger) and surface a fixed message on the wire.
      const verifyResult = yield* Effect.promise(() =>
        verifyAuthenticationResponse({
          response: assertion,
          expectedChallenge: entry.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          requireUserVerification: true,
          credential: {
            id: pk.credentialId,
            publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64")),
            counter: pk.counter,
            transports: pk.transports
              ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
              : undefined,
          },
        }).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
      );
      if (!verifyResult.ok) {
        yield* Effect.logWarning("auth.passkey.verify threw", {
          cause: verifyResult.e instanceof Error ? verifyResult.e.message : String(verifyResult.e),
        });
        return yield* Effect.fail(new AuthError({ message: "Passkey verification failed" }));
      }
      const verification = verifyResult.v;
      if (!verification.verified) {
        return yield* Effect.fail(new AuthError({ message: "Passkey verification failed" }));
      }

      // Update counter + coalesced last_used_at (parallel to sessions).
      const nowSec = Math.floor(Date.now() / 1000);
      const shouldTouchLastUsed =
        !pk.lastUsedAt || Date.now() - pk.lastUsedAt * 1000 >= PASSKEY_LAST_USED_COALESCE_MS;
      const updates: Partial<Pick<NewPasskey, "counter" | "lastUsedAt" | "updatedAt">> = {
        counter: verification.authenticationInfo.newCounter,
      };
      if (shouldTouchLastUsed) {
        updates["lastUsedAt"] = nowSec;
        updates["updatedAt"] = nowSec;
      }
      yield* Effect.tryPromise({
        try: () => db.update(passkeys).set(updates).where(eq(passkeys.id, pk.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return profile;
    });

  // -------------------------------------------------------------------------
  // Passkey: complete login — returns a Session + PublicProfile directly.
  // -------------------------------------------------------------------------

  const completePasskeyLoginDirect = (
    input:
      | { identifier: string; assertion: AuthenticationResponseJSON }
      | { challengeId: string; assertion: AuthenticationResponseJSON },
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ session: TokenSet; profile: PublicProfile }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const isDiscoverable = "challengeId" in input;
      const context: PasskeyLoginContext = isDiscoverable
        ? { kind: "discoverable", challengeId: input.challengeId }
        : { kind: "identified", identifier: input.identifier };
      const profile = yield* verifyPasskeyAssertion(context, input.assertion).pipe(
        Effect.tap(() =>
          isDiscoverable ? Effect.sync(() => metricPasskeyLoginDiscoverable("ok")) : Effect.void,
        ),
        Effect.tapError((e) =>
          isDiscoverable
            ? Effect.sync(() => metricPasskeyLoginDiscoverable(classifyError(e)))
            : Effect.void,
        ),
      );
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
    }).pipe(withAuthLogin("passkey"));

  return {
    beginPasskeyRegistration,
    completePasskeyRegistration,
    beginPasskeyLogin,
    completePasskeyLoginDirect,
  };
}

export type PasskeysModule = ReturnType<typeof createPasskeysModule>;
