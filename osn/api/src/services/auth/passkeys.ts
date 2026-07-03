/**
 * Passkey ceremonies: registration begin/complete (step-up gated past the
 * first credential) and login begin/complete, including the discoverable
 * (conditional-UI) flow and the shared assertion verifier.
 */

import { accounts, passkeys, securityEvents, sessions, users } from "@osn/db/schema";
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
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  classifyError,
  metricPasskeyLoginDiscoverable,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAuthLogin,
} from "../../metrics";
import {
  CHALLENGE_TTL_MS,
  MAX_PASSKEYS_PER_ACCOUNT,
  PASSKEY_LAST_USED_COALESCE_MS,
} from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genId, hashSessionToken, normaliseIdentifier, now, probeAccountId } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { SecurityEventsModule } from "./security-events";
import type { SessionsModule } from "./sessions";
import type { StepUpModule } from "./step-up";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, PublicProfile, SessionMeta, TokenSet } from "./types";
import { toPublicProfile } from "./types";

// P-I2: hoisted — a TextEncoder is stateless, so one module-level instance
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
  const { config, stores, hashIp } = ctx;
  const { resolveIdentifier, findDefaultProfile } = profiles;
  const { issueTokens } = tokens;
  const { invalidateOtherAccountSessions } = sessions_;
  const { verifyStepUpForPasskeyRegister } = stepUp;
  /** See {@link SecurityEventsModule.notifySecurityEventByAccountId}. */
  const notifyPasskeyRegisteredByAccountId = (accountId: string) =>
    securityEventsModule.notifySecurityEventByAccountId(
      accountId,
      "passkey_register",
      "passkey-added",
    );

  const beginPasskeyRegistration = (
    accountId: string,
    /**
     * S-H1: required when the account already has ≥1 passkey. First-
     * credential enrollment (bootstrap) bypasses the gate — no step-up
     * ceremony is reachable before the account has any authenticators.
     * Verified below after the existingPasskeys read.
     */
    stepUpToken?: string,
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

      // P-I10: refuse to mint options past the per-account cap. Checked
      // BEFORE the step-up gate so a user who's already at the cap
      // doesn't burn a single-use step-up token for nothing.
      if (existingPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return yield* Effect.fail(
          new AuthError({ message: "Passkey limit reached for this account" }),
        );
      }

      // S-H1: once the account has any passkey, adding another requires a
      // fresh step-up token. A stolen access token alone cannot bind a
      // new authenticator.
      if (existingPasskeys.length > 0) {
        if (!stepUpToken) {
          return yield* Effect.fail(new AuthError({ message: "Step-up required" }));
        }
        yield* verifyStepUpForPasskeyRegister(accountId, stepUpToken);
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
            // verifier's `requireUserVerification: true` anyway (S-H2 —
            // options and verify must agree).
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
          { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS },
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
     * Raw session token of the caller, hashed internally so all OTHER
     * sessions for this account can be revoked (H1). The route layer
     * derives this from the HttpOnly cookie — it is NOT user-supplied
     * body input — so an attacker with only an access token cannot skip
     * H1 invalidation by omitting a body field (S-H1).
     */
    currentSessionToken: string | null,
    /** IP + UA for the security_events row (S-H1). Best-effort; omitted in tests. */
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

      // S-H1: write the audit row in the SAME transaction as the passkey
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

      // P-W1 / P-I10: cap enforcement. `beginPasskeyRegistration` already refuses
      // past the limit; this is the belt-and-braces check. D1 has no interactive
      // transaction, so the count read runs first and the passkey + audit insert
      // commit as one atomic batch. A pair of completes racing the cap could
      // exceed it by one — a benign over-count, not a security exposure (the
      // begin-side check is the primary guard).
      const passkeyCount = yield* Effect.tryPromise({
        try: () =>
          db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (passkeyCount.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return yield* Effect.fail(
          new AuthError({ message: "Passkey limit reached for this account" }),
        );
      }
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
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

      // H1: Invalidate all other sessions on passkey registration.
      // An attacker who stole a session token cannot persist after the
      // legitimate user adds a passkey.
      if (currentSessionToken) {
        yield* invalidateOtherAccountSessions(accountId, hashSessionToken(currentSessionToken));
      } else {
        // O4: caller has no resolvable session token (cookie stripped by a
        // proxy, or the registration arrived via the enrollment-token path).
        // Previously this branch was a silent no-op — H1 invalidation was
        // skipped entirely, so a stolen session survived the very enrolment
        // that is supposed to evict it. Mirror deletePasskey's cookieless
        // branch: nuke EVERY session on the account (there is no "self" to
        // preserve), log the anomaly out-of-band, and emit the canonical
        // invalidation metric so the H1 dashboard still records the event.
        yield* Effect.logWarning("auth.passkey.register: nuking all sessions (no caller session)");
        yield* Effect.tryPromise({
          try: () => db.delete(sessions).where(eq(sessions.accountId, accountId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricSessionSecurityInvalidation("passkey_register");
      }

      // S-H1: best-effort email notification. Forked daemon — failure
      // logged but never rolls back the enrolment. 10s timeout matches
      // passkey_delete / recovery_code_* paths.
      yield* Effect.forkDaemon(
        notifyPasskeyRegisteredByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

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
        // O3: the store self-bounds (CEREMONY_STORE_MAX in-memory, native PX
        // expiry on Redis) and sweeps expired entries on insert, so the prior
        // explicit P-I2 size-cap check is folded into the store.
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
      // latency distribution is the same (S-M1: no timing oracle).
      const { db } = yield* Db;
      const profilePasskeys = profile
        ? yield* Effect.tryPromise({
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, profile.accountId)),
            catch: (cause) => new DatabaseError({ cause }),
          })
        : yield* Effect.tryPromise({
            // Burn-in query: hit the table with a never-matching accountId
            // so an unknown identifier costs the same shape of work as a
            // known one. O5: random per-request sentinel — see probeAccountId.
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, probeAccountId())),
            catch: (cause) => new DatabaseError({ cause }),
          });

      // S-M1: equalise the response envelope. Unknown identifier AND
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
            // S-H2: `verifyAuthenticationResponse` sets
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
        // O3: store self-bounds + self-sweeps (see discoverable branch above).
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
        // S-M3: discoverable flow — the credential row supplies the account.
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

      // S-L5: never reflect the WebAuthn library's error text to the caller —
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

      // Update counter + coalesced last_used_at (P-W4 parallel to sessions).
      const nowSec = Math.floor(Date.now() / 1000);
      const shouldTouchLastUsed =
        !pk.lastUsedAt || Date.now() - pk.lastUsedAt * 1000 >= PASSKEY_LAST_USED_COALESCE_MS;
      const updates: Record<string, number | boolean> = {
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
