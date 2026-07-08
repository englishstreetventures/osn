/**
 * Account creation: the legacy direct `registerProfile`, the two-step
 * email-OTP registration ceremony, and the public handle-availability check.
 */

import { accounts, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch } from "@shared/db-utils";
import { type EmailError, EmailService } from "@shared/email";
import { eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect, Schema } from "effect";

import { timingSafeEqualString } from "../../lib/timing-safe";
import { metricAuthHandleCheck, metricAuthOtpSent, withAuthRegister } from "../../metrics";
import { MAX_OTP_ATTEMPTS, MIN_AGE_YEARS, RESERVED_HANDLES } from "./constants";
import type { AuthContext } from "./context";
import { AgeRestrictionError, AuthError, DatabaseError, ValidationError } from "./errors";
import {
  ageInYears,
  BirthdateSchema,
  EmailSchema,
  genId,
  genOtpCode,
  HandleSchema,
  hashSessionToken,
  logDevOtp,
  now,
} from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, SessionMeta } from "./types";

export function createRegistrationModule(
  ctx: AuthContext,
  // P-W11: uniqueness probes now run as a single inline UNION ALL query, so the
  // profiles module is no longer consulted. Parameter kept (underscore-
  // prefixed) so the module factory wiring in index.ts stays uniform.
  _profiles: ProfilesModule,
  tokens: TokensModule,
) {
  const { stores, otpTtl } = ctx;
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
      yield* Schema.decodeUnknown(EmailSchema)(email).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );

      if (RESERVED_HANDLES.has(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      const { db } = yield* Db;
      // P-W11: single round-trip uniqueness probe. UNION ALL of two
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
      };
    });

  /**
   * Step 1 of email-verified registration. Validates input, normalises the
   * email to lowercase, generates an unbiased 6-digit OTP, stores a pending
   * registration entry, and emails the code. No DB row is created yet.
   *
   * Security properties:
   *  - Always returns `{ sent: true }` regardless of whether the email or
   *    handle is already taken (S-M1: removes the user-enumeration oracle).
   *    The "is this handle free?" question is answered separately by the
   *    public `/handle/:handle` endpoint, which is the appropriate channel
   *    and can be rate-limited independently.
   *  - The pending-registrations store is self-bounding (CEREMONY_STORE_MAX
   *    in-memory, native PX expiry on Redis) and sweeps expired entries on
   *    insert, so unauthenticated abuse can't grow it without bound (S-M2 / P-W1).
   *  - Refuses to overwrite a non-expired pending entry, preventing an
   *    attacker from resetting a victim's in-progress OTP (S-M2).
   *  - The local-only `Effect.logDebug` of the OTP is gated on
   *    `OSN_ENV` being unset or `"local"` (S-M3 / S-L2).
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
    AgeRestrictionError | AuthError | ValidationError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(EmailSchema)(email).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknown(BirthdateSchema)(birthdate).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );

      // C-H8 (COPPA): hard-reject under-13 BEFORE any personal information is
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

      // Normalise email to lowercase (S-H3) — the canonical form is what we
      // persist and what we key the pending-registrations map by.
      const normalisedEmail = email.toLowerCase();

      // O3: the store sweeps expired entries and self-bounds (CEREMONY_STORE_MAX
      // on the in-memory backend, native PX expiry on Redis), so no explicit
      // sweep / size cap is needed here any more.
      // P-W11: single round-trip existence probe — UNION ALL of two indexed
      // single-table arms (see registerProfile for why not an OR across the
      // join). S-M1 below responds identically for either collision, so no
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

      // S-M1: silently no-op when the email/handle already exists. The user
      // can use the login flow if they already have an account; we don't
      // confirm or deny their existence over an unauthenticated channel.
      if (collision.length > 0) {
        return { sent: true };
      }

      // S-M2: don't let an attacker reset a victim's in-progress OTP by
      // re-posting begin with the same email.
      const existingPending = yield* Effect.promise(() =>
        stores.pendingRegistrations.get(normalisedEmail),
      );
      if (existingPending && existingPending.expiresAt > Date.now()) {
        return { sent: true };
      }

      const code = genOtpCode();
      yield* Effect.promise(() =>
        stores.pendingRegistrations.set(
          normalisedEmail,
          {
            email: normalisedEmail,
            handle,
            displayName: displayName ?? null,
            codeHash: hashSessionToken(code),
            attempts: 0,
            expiresAt: Date.now() + otpTtl * 1000,
          },
          otpTtl * 1000,
        ),
      );

      yield* logDevOtp("registration", normalisedEmail, code);

      // S-M3: the EmailService layer decides whether to actually dispatch
      // or just log. `LogEmailLive` (local dev + tests) captures the
      // rendered body in-memory for operator inspection without opening
      // a network connection; `CloudflareEmailLive` (staging / prod)
      // POSTs directly to the Cloudflare Email Service REST API.
      const emailSvc = yield* EmailService;
      yield* emailSvc
        .send({
          template: "otp-registration",
          to: normalisedEmail,
          data: { code, ttlMinutes: otpTtl / 60 },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) =>
              new AuthError({ message: `Failed to send email: ${cause.reason}` }),
          ),
        );

      metricAuthOtpSent("registration");
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
   *  - Constant-time OTP comparison (S-M4 / `timingSafeEqualString`).
   *  - Per-entry attempt counter; after MAX_OTP_ATTEMPTS the entry is wiped,
   *    capping brute-force probability at ~5/1_000_000 per registration.
   *  - The pending entry is only deleted AFTER a successful insert. A losing
   *    race against another insert (TOCTOU) leaves the pending entry intact
   *    so the user can retry without burning their OTP (S-H4).
   *  - Insert relies on the DB-level UNIQUE constraint on email/handle as
   *    the source of truth, mapping constraint violations to a clean
   *    AuthError instead of leaking driver text (S-H4 / S-H5).
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
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const key = email.toLowerCase();
      const pending = yield* Effect.promise(() => stores.pendingRegistrations.get(key));
      if (!pending || Date.now() > pending.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      if (!timingSafeEqualString(pending.codeHash, hashSessionToken(code))) {
        // Increment the attempt counter; wipe after too many guesses. O3: the
        // store does not alias the returned value, so persist the bump back
        // (and carry the remaining TTL so the entry still expires on schedule).
        const attempts = pending.attempts + 1;
        if (attempts >= MAX_OTP_ATTEMPTS) {
          yield* Effect.promise(() => stores.pendingRegistrations.delete(key));
        } else {
          yield* Effect.promise(() =>
            stores.pendingRegistrations.set(
              key,
              { ...pending, attempts },
              Math.max(0, pending.expiresAt - Date.now()),
            ),
          );
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const accountId = genId("acc_");
      const id = genId("usr_");
      const ts = now();

      // Insert account + profile. The DB-level UNIQUE constraints on `email`
      // and `handle` are the source of truth for race-free uniqueness; a
      // constraint violation here means another registration won the race
      // (or the legacy `/register` endpoint was called concurrently). We
      // surface that as a clean AuthError without leaking driver text.
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
            const msg = e instanceof Error ? e.message : String(e);
            if (/UNIQUE|constraint/i.test(msg)) {
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

      // Success: only NOW delete the pending entry.
      yield* Effect.promise(() => stores.pendingRegistrations.delete(key));

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
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
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
