/**
 * Account creation: the legacy direct `registerProfile`, the two-step
 * email-OTP registration ceremony, and the public handle-availability check.
 */

import { accounts, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { commitBatch, driverErrorText } from "@shared/db-utils";
import { EmailError, EmailService } from "@shared/email";
import { eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect, Schema } from "effect";

import { forkBackground } from "../../lib/background";
import { UNIQUE_CONSTRAINT_ERROR } from "../../lib/unique-constraint";
import { metricAuthHandleCheck, metricAuthOtpSent, withAuthRegister } from "../../metrics";
import { guessEntry, spendEntry } from "./attempts";
import { MAX_OTP_ATTEMPTS, MIN_AGE_YEARS, RESERVED_HANDLES } from "./constants";
import type { AuthContext } from "./context";
import {
  AgeRestrictionError,
  AuthError,
  type CoordinationError,
  DatabaseError,
  ValidationError,
} from "./errors";
import {
  ageInYears,
  BirthdateSchema,
  EmailSchema,
  genId,
  genOtpCode,
  HandleSchema,
  hashSessionToken,
  logDevOtp,
  MAX_IDENTIFIER_LENGTH,
  now,
} from "./helpers";
import type { ProfilesModule } from "./profiles";
import { storeCall } from "./store-call";
import type { PendingRegistration } from "./stores";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, SessionMeta } from "./types";

export function createRegistrationModule(
  ctx: AuthContext,
  // Uniqueness probes run as a single inline UNION ALL query, so the profiles
  // module is not consulted. The parameter stays (underscore-prefixed) so the
  // module factory wiring in index.ts stays uniform.
  _profiles: ProfilesModule,
  tokens: TokensModule,
) {
  const { config, stores, otpTtl, serverMac } = ctx;
  const { issueTokens } = tokens;

  /**
   * Registers a new profile (and its owning account). Fails if the email or handle is already taken.
   * This is the only way to create a profile — OTP/magic/passkey flows are login-only.
   */
  const registerProfile = (
    email: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<ProfileWithEmail, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(EmailSchema)(email).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknownEffect(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );

      if (RESERVED_HANDLES.has(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      const { db } = yield* Db;
      // A single round-trip uniqueness probe: UNION ALL of two
      // single-table arms rather than `WHERE email = ? OR handle = ?` across
      // the users⋈accounts join — an OR spanning two joined tables defeats
      // SQLite's OR-optimization and plans as a full `users` scan, while each
      // arm here is a seek on its UNIQUE index (accounts.email / users.handle).
      // The email error takes priority (same order as the old two checks).
      const collisions = yield* Effect.tryPromise({
        try: () =>
          // No per-arm LIMIT: SQLite rejects LIMIT inside compound arms, and
          // both columns are UNIQUE so each arm yields at most one row anyway.
          unionAll(
            db
              .select({ field: sql<string>`'email'`.as("field") })
              .from(accounts)
              .where(eq(accounts.email, email)),
            db
              .select({ field: sql<string>`'handle'`.as("field") })
              .from(users)
              .where(eq(users.handle, handle)),
          ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (collisions.some((c) => c.field === "email")) {
        return yield* Effect.fail(new AuthError({ message: "Email already registered" }));
      }
      if (collisions.some((c) => c.field === "handle")) {
        return yield* Effect.fail(new AuthError({ message: "Handle already taken" }));
      }

      const accountId = genId("acc_");
      const id = genId("usr_");
      const ts = now();
      const dn = displayName ?? null;

      yield* Effect.tryPromise({
        // Account + default profile inserted atomically (batch on D1, sequential
        // on bun:sqlite). Uniqueness is pre-checked above and backstopped by the
        // UNIQUE constraints on accounts.email / users.handle.
        try: () =>
          commitBatch(db, [
            db.insert(accounts).values({
              id: accountId,
              email,
              passkeyUserId: crypto.randomUUID(),
              maxProfiles: 5,
              createdAt: ts,
              updatedAt: ts,
            }),
            db.insert(users).values({
              id,
              accountId,
              handle,
              displayName: dn,
              isDefault: true,
              createdAt: ts,
              updatedAt: ts,
            }),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return {
        id,
        accountId,
        handle,
        email,
        displayName: dn,
        avatarUrl: null,
        isDefault: true,
        createdAt: ts,
        updatedAt: ts,
        // The account was created a statement ago; it has never been recovered.
        lastRecoveredAt: null,
      };
    });

  /**
   * How long a sign-up whose code may still arrive keeps its pending entry
   * after the send failed: a retry inside it sends nothing, one after it sends
   * a new code.
   */
  const UNKNOWN_DELIVERY_HOLD_MS = 60_000;

  /**
   * Whether a failed send might still have delivered its code. A refusal, a
   * rate limit or a failed render sent nothing. A request that timed out or
   * never got an answer may have reached Resend, which can still deliver it.
   */
  const deliveryOf = (error: unknown): "none" | "unknown" =>
    error instanceof EmailError && error.reason !== "api_unreachable" ? "none" : "unknown";

  /**
   * Settle `parked`, the pending registration this begin wrote at `key`, after
   * its code's send failed. It is one store call that names `parked`, so it
   * touches no other entry: one spent since — by the cap, or by the
   * registration its code completed — is not brought back, and one a later
   * begin wrote once this one was spent or expired stays, since that one's
   * code may have arrived.
   *
   * - Nothing was sent: `parked` goes, so a retry sends a new code.
   * - The code may still arrive: `parked` stays, with at most
   *   {@link UNKNOWN_DELIVERY_HOLD_MS} left to live, so the address gets no
   *   second code at once and the person can retry a minute later. Deleting it
   *   instead would let each begin mail the address again while sends are
   *   slow. The stored value is the same one, so a guess that read it before
   *   the hold still names it when it deletes.
   *
   * A store call that fails leaves the entry as it was, to expire.
   *
   * Holding the entry rewrites it, and a rewrite starts its guess count again.
   * That allows at most one more cap's worth of guesses, inside the minute the
   * entry is held, against a code whose send failed — a bound the cap's own
   * arithmetic absorbs (ten six-digit guesses, not five).
   */
  const settleFailedSend = (
    key: string,
    parked: PendingRegistration,
    delivery: "none" | "unknown",
  ): Effect.Effect<void> =>
    // Best effort: the send has already failed, and the caller's answer does
    // not depend on this tidying.
    Effect.promise(async () => {
      if (delivery === "none") {
        await stores.pendingRegistrations.delete(key, parked).catch(() => undefined);
        return;
      }
      const left = Math.min(parked.expiresAt - Date.now(), UNKNOWN_DELIVERY_HOLD_MS);
      await stores.pendingRegistrations
        .swap(key, parked, parked, Math.max(1, left))
        .catch(() => false);
    });

  /**
   * Step 1 of email-verified registration. Validates input, normalises the
   * email to lowercase, generates an unbiased 6-digit OTP, stores a pending
   * registration entry, and emails the code. No DB row is created yet.
   *
   * Security properties:
   *  - Always returns `{ sent: true }` regardless of whether the email or
   *    handle is already taken, and whether or not the code's email went out,
   *    so neither the status nor the body says whether an address has an
   *    account. Every branch answers after the one store call: the code's
   *    send runs after the answer, so the time to answer does not say either.
   *    The "is this handle free?" question is answered separately by the
   *    public `/handle/:handle` endpoint, which is the appropriate channel
   *    and can be rate-limited independently.
   *  - A send that failed and sent nothing removes its own pending entry, so a
   *    retry sends a new code rather than meeting the pending check for the
   *    code's whole life. A send whose code may still arrive (timed out,
   *    unreachable) holds its entry for a minute instead. The cost: a person
   *    whose send failed is told a code was sent. The transport logs why
   *    (`email.dispatch_failed`, or `email.dispatch_interrupted` on the
   *    timeout), and `osn.email.send.attempts{outcome="failed"}` counts it;
   *    this function's own attempt counter records the begin as `ok`.
   *  - The pending-registrations store is self-bounding (CEREMONY_STORE_MAX
   *    in-memory, per-entry TTL on the Durable Object store) and sweeps expired entries on
   *    insert, so unauthenticated abuse can't grow it without bound.
   *  - Refuses to overwrite a non-expired pending entry, so a second begin
   *    for someone's address cannot reset the code they hold. The check and
   *    the write are one store call (`swap` from nothing), so of two begins
   *    that overlap, one parks its code and the other sends nothing.
   *  - The local-only `Effect.logDebug` of the OTP is gated on
   *    `OSN_ENV` being unset or `"local"`.
   *
   * Validation errors (bad email format, bad handle format, reserved handle)
   * are still surfaced as ValidationError / AuthError because they're not
   * enumeration leaks — the same input would fail client-side too.
   */
  const beginRegistration = (
    email: string,
    handle: string,
    birthdate: string,
    displayName?: string,
  ): Effect.Effect<
    { sent: boolean },
    AgeRestrictionError | AuthError | ValidationError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(EmailSchema)(email).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknownEffect(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknownEffect(BirthdateSchema)(birthdate).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );

      // COPPA: hard-reject under-13 BEFORE any personal information is
      // collected — before the OTP is sent and before we even probe for
      // email/handle collisions. The birthdate is used transiently here and is
      // never written to any store or table, so a rejected (or accepted)
      // registration leaves no date-of-birth behind. See [[compliance/coppa]].
      if (ageInYears(birthdate) < MIN_AGE_YEARS) {
        return yield* Effect.fail(new AgeRestrictionError());
      }

      if (RESERVED_HANDLES.has(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      // Normalise email to lowercase — the canonical form is what we
      // persist and what we key the pending-registrations map by.
      const normalisedEmail = email.toLowerCase();

      // The store sweeps expired entries and self-bounds (CEREMONY_STORE_MAX
      // on the in-memory backend, per-entry TTL on the Durable Object store), so no explicit
      // sweep / size cap is needed here any more.
      // A single round-trip existence probe — UNION ALL of two indexed
      // single-table arms (see registerProfile for why not an OR across the
      // join). The collision branch below responds identically for either, so no
      // per-field distinction is needed.
      const { db } = yield* Db;
      const collision = yield* Effect.tryPromise({
        try: () =>
          // No per-arm LIMIT — see registerProfile's probe.
          unionAll(
            db
              .select({ hit: sql<number>`1`.as("hit") })
              .from(accounts)
              .where(eq(accounts.email, normalisedEmail)),
            db
              .select({ hit: sql<number>`1`.as("hit") })
              .from(users)
              .where(eq(users.handle, handle)),
          ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Silently no-op when the email or handle already exists. The user
      // can use the login flow if they already have an account; we don't
      // confirm or deny their existence over an unauthenticated channel.
      const taken = collision.length > 0;

      // Every branch — the address or handle taken, a code already pending,
      // a code sent — makes the same one store call, a swap from nothing, so
      // the branches cost the same in store round trips and fail together
      // while the store is down. A swap that finds a live entry leaves it as
      // it was, so a second begin for someone's address cannot reset the code
      // they hold, however the two overlap. The taken branch makes it at the
      // caller's probe key, which no `complete` reads; the value parked there
      // holds a hash no code matches.
      const code = genOtpCode();
      const codeHash = hashSessionToken(code);
      const expiresAt = Date.now() + otpTtl * 1000;
      const parked: PendingRegistration = taken
        ? {
            email: "",
            handle: "",
            displayName: null,
            codeHash: hashSessionToken(genOtpCode() + genId("")),
            expiresAt,
          }
        : {
            email: normalisedEmail,
            handle,
            displayName: displayName ?? null,
            codeHash,
            expiresAt,
          };
      const key = taken ? serverMac.probeKey(normalisedEmail) : normalisedEmail;
      const written = yield* storeCall(stores.pendingRegistrations, "swap", () =>
        stores.pendingRegistrations.swap(key, null, parked, otpTtl * 1000),
      );
      if (taken || !written) return { sent: true };

      yield* logDevOtp("registration", code);

      // The EmailService layer decides where the code goes: the in-memory
      // recorder locally and in tests, Resend in every deployed tier.
      //
      // The send runs after the answer, forked with a timeout as
      // `beginEmailRecovery` forks its own. Awaiting it would make this branch
      // answer a Resend round trip later than the taken and pending branches,
      // which make the same one store call and return: the response time would
      // say whether the address has an account, whatever the body says.
      // `forkBackground` registers the fibre with the request's `waitUntil`,
      // so the send still runs on workerd once the response is out.
      //
      // A send that fails — refused, unreachable, or slower than ten seconds —
      // settles this request's pending entry (`settleFailedSend`): gone when
      // nothing was sent, so "Resend code" sends a new code; held for a minute
      // when the code may still arrive. The transport has already logged why
      // the send failed.
      const emailSvc = yield* EmailService;
      yield* forkBackground(
        emailSvc
          .send({
            template: "otp-registration",
            to: normalisedEmail,
            data: { code, ttlMinutes: otpTtl / 60, instanceName: config.instanceName },
          })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.tap(() => Effect.sync(() => metricAuthOtpSent("registration"))),
            Effect.catch((error) => settleFailedSend(key, parked, deliveryOf(error))),
          ),
      );

      return { sent: true };
    }).pipe(withAuthRegister("begin"));

  /**
   * Step 2 of email-verified registration. Verifies the OTP against the
   * pending registration and, if valid, creates the account + profile rows
   * and returns a full session (access + refresh tokens).
   *
   * The UI then immediately drives the `/passkey/register/*` flow using
   * the returned access token to enroll the user's first passkey. Accounts
   * without a passkey cannot make it past registration because the UI
   * refuses to dismiss until enrollment succeeds, and `deletePasskey`
   * refuses to drop below 1 — so every live account always has ≥1 passkey.
   *
   * Security properties:
   *  - Constant-time OTP comparison (`timingSafeEqualString`).
   *  - Per-entry attempt counter; after MAX_OTP_ATTEMPTS the entry is wiped,
   *    capping brute-force probability at ~5/1_000_000 per registration.
   *  - The pending entry is only deleted AFTER a successful insert. A losing
   *    race against another insert (TOCTOU) leaves the pending entry intact
   *    so the user can retry without burning their OTP.
   *  - Insert relies on the DB-level UNIQUE constraint on email/handle as
   *    the source of truth, mapping *uniqueness* violations to a clean
   *    AuthError instead of leaking driver text. Any other
   *    constraint failure surfaces as DatabaseError.
   */
  const completeRegistration = (
    email: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    {
      profileId: string;
      handle: string;
      email: string;
      displayName: string | null;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    },
    AuthError | DatabaseError | CoordinationError,
    Db
  > =>
    Effect.gen(function* () {
      const key = email.toLowerCase();
      // Longer than any address an account can hold, and too long to key an entry.
      if (key.length > MAX_IDENTIFIER_LENGTH) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      // Read and counted in one call, before the code is compared; see
      // `attempts.ts`. The entry is deleted after the insert below, not
      // claimed here, so an insert that loses a race leaves the code usable;
      // the count and the UNIQUE constraints keep two right codes from both
      // registering.
      const guessed = yield* guessEntry(stores.pendingRegistrations, key, MAX_OTP_ATTEMPTS);
      if (!guessed) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      const { entry: pending, standing } = guessed;
      if (standing === "spent") {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!timingSafeEqualString(pending.codeHash, hashSessionToken(code))) {
        if (standing === "last") yield* spendEntry(stores.pendingRegistrations, key, pending);
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const accountId = genId("acc_");
      const id = genId("usr_");
      const ts = now();

      // Insert account + profile. The DB-level UNIQUE constraints on `email`
      // and `handle` are the source of truth for race-free uniqueness; a
      // UNIQUE violation here means another registration won the race (or
      // the legacy `/register` endpoint was called concurrently), and we
      // surface that as a clean AuthError without leaking driver text. Any
      // other constraint failure (NOT NULL / FOREIGN KEY / CHECK) is a DB
      // fault, not a user race, and surfaces as DatabaseError instead — see
      // `UNIQUE_CONSTRAINT_ERROR` for why the match is narrowed this way.
      const inserted = yield* Effect.tryPromise({
        try: async () => {
          try {
            await commitBatch(db, [
              db.insert(accounts).values({
                id: accountId,
                email: pending.email,
                passkeyUserId: crypto.randomUUID(),
                maxProfiles: 5,
                createdAt: ts,
                updatedAt: ts,
              }),
              db.insert(users).values({
                id,
                accountId,
                handle: pending.handle,
                displayName: pending.displayName,
                isDefault: true,
                createdAt: ts,
                updatedAt: ts,
              }),
            ]);
            return { ok: true as const };
          } catch (e) {
            const msg = driverErrorText(e);
            if (UNIQUE_CONSTRAINT_ERROR.test(msg)) {
              return { ok: false as const, reason: "conflict" };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!inserted.ok) {
        // Don't burn the pending entry — the user can still retry if the
        // conflicting insert is rolled back. The collision is rare in
        // practice (race window is microseconds).
        return yield* Effect.fail(new AuthError({ message: "Email or handle already registered" }));
      }

      // Success: only NOW delete the pending entry, and its guess count with
      // it — after the answer, since the account exists whatever happens
      // here. Only the entry this guess read goes. Nothing a later request
      // writes can be at this key by then: once the account exists, `begin`
      // finds the address taken and writes at its probe key. A store fault is
      // not the caller's answer; an entry left behind expires with its TTL.
      yield* forkBackground(
        spendEntry(stores.pendingRegistrations, key, pending).pipe(Effect.ignore),
      );

      const issued = yield* issueTokens(
        id,
        accountId,
        pending.email,
        pending.handle,
        pending.displayName,
        undefined,
        sessionMeta,
      );

      return {
        profileId: id,
        handle: pending.handle,
        email: pending.email,
        displayName: pending.displayName,
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresIn: issued.expiresIn,
      };
    }).pipe(withAuthRegister("complete"));

  /**
   * Checks whether a handle is valid format and not yet taken.
   */
  const checkHandle = (
    handle: string,
  ): Effect.Effect<{ available: boolean }, ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(HandleSchema)(handle).pipe(
        Effect.tapError(() => Effect.sync(() => metricAuthHandleCheck("invalid"))),
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (RESERVED_HANDLES.has(handle)) {
        metricAuthHandleCheck("taken");
        return { available: false };
      }
      // Availability only needs existence, not the profile — a single-column
      // `users.handle` probe instead of `findProfileByHandle`'s account join
      // (which exists to hydrate the email for its other callers). Keeps this
      // high-frequency, debounced endpoint as light as possible.
      const { db } = yield* Db;
      const existing = yield* Effect.tryPromise({
        try: () => db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const taken = existing.length > 0;
      metricAuthHandleCheck(taken ? "taken" : "available");
      return { available: !taken };
    }).pipe(Effect.withSpan("auth.handle.check"));

  return {
    registerProfile,
    beginRegistration,
    completeRegistration,
    checkHandle,
  };
}

export type RegistrationModule = ReturnType<typeof createRegistrationModule>;
