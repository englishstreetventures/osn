/**
 * Account creation: the legacy direct `registerProfile`, sign-up through an
 * emailed link (begin, resend, status), and the public handle-availability
 * check.
 */

import { accounts, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch, driverErrorText } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import { eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect, Schema } from "effect";

import { forkBackground } from "../../lib/background";
import { UNIQUE_CONSTRAINT_ERROR } from "../../lib/unique-constraint";
import { metricAuthHandleCheck, metricEmailLinkSend, withAuthRegister } from "../../metrics";
import { spendEntry } from "./attempts";
import { MIN_AGE_YEARS, RESERVED_HANDLES } from "./constants";
import type { AuthContext } from "./context";
import type { EmailLinkModule } from "./email-link";
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
  HandleSchema,
  logDevLink,
  now,
} from "./helpers";
import type { ProfilesModule } from "./profiles";
import { storeCall } from "./store-call";
import type { EmailLinkChallenge, PendingRegistration } from "./stores";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, SessionMeta } from "./types";

/** What a sign-up status poll answers. */
export type RegistrationStatus =
  | { readonly status: "pending" }
  | { readonly status: "expired" }
  | { readonly status: "conflict" }
  | {
      readonly status: "complete";
      readonly profileId: string;
      readonly handle: string;
      readonly email: string;
      readonly displayName: string | null;
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly expiresIn: number;
    };

export function createRegistrationModule(
  ctx: AuthContext,
  // Uniqueness probes run as a single inline UNION ALL query, so the profiles
  // module is not consulted. The parameter stays (underscore-prefixed) so the
  // module factory wiring in index.ts stays uniform.
  _profiles: ProfilesModule,
  tokens: TokensModule,
  links: EmailLinkModule,
) {
  const { config, stores, otpTtl, serverMac, registrationSendCap, registrationLinkLockoutStore } =
    ctx;
  const { issueTokens } = tokens;

  /**
   * Registers a new profile (and its owning account) directly, with no proof of
   * the address. Fails if the email or handle is already taken. Seed scripts
   * and tests use it; people sign up through the emailed link below.
   * The email is stored and returned lower-cased, as `beginRegistration` stores it.
   */
  const registerProfile = (
    typedEmail: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<ProfileWithEmail, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const email = typedEmail.toLowerCase();
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
   * Mails the sign-up link for `handle` to `address`, after the answer: the
   * caller forks it. The address's limits are read here, so they cost the
   * answer nothing and are reached only where a link goes out — never for a
   * taken address:
   *
   *  - no link goes to an address whose sign-up links drew three wrong picks
   *    today;
   *  - a Resend's link counts against the address's hourly cap, and goes no
   *    further past it. A begin's first link does not count, so the newest
   *    sign-up always gets its first link whatever Resends came before it.
   *
   * Either store failing to answer sends nothing. A held-back or failed send
   * is counted and goes no further; the transport has already logged why a
   * send failed. The request stays live either way, and Resend on it is the
   * retry.
   */
  const sendLink = (
    address: string,
    handle: string,
    url: string,
    ttlMinutes: number,
    kind: "first" | "resend",
  ) =>
    Effect.gen(function* () {
      const key = serverMac.probeKey(address);
      const strikes = yield* Effect.promise(() => registrationLinkLockoutStore.status(key));
      const allowed =
        strikes.status === "open" &&
        (kind === "first" || (yield* Effect.promise(() => registrationSendCap.check(key))));
      if (!allowed) {
        metricEmailLinkSend("registration", "capped");
        return;
      }
      const emailSvc = yield* EmailService;
      yield* emailSvc
        .send({
          template: "link-registration",
          to: address,
          data: { url, ttlMinutes, instanceName: config.instanceName, handle },
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.tap(() => Effect.sync(() => metricEmailLinkSend("registration", "sent"))),
          Effect.catch(() => Effect.sync(() => metricEmailLinkSend("registration", "failed"))),
        );
    });

  /**
   * Step 1 of sign-up. Validates input, normalises the email to lowercase,
   * opens an emailed-link request and parks the sign-up beside it, then mails
   * the link. No account row is created yet.
   *
   * Answers `{ requestId, claimSecret, pairingCode, expiresAt }` to the tab
   * that began. The tab keeps the claim secret and polls `registrationStatus`
   * with it, and shows the pairing code, which the confirm step requires; the
   * link goes only to the address.
   *
   * Security properties:
   *  - Every branch — the address or handle taken, a sign-up already pending
   *    for the address, a link sent — answers the same shape after the same
   *    two store calls (the link request's write, then a swap from nothing on
   *    the pending entry), and mails after the answer. Neither the body, the
   *    status nor the time to answer says whether an address has an account.
   *    A taken address gets a request whose link is never sent, so its poll
   *    stays `pending` until it expires, as a real one's does unconfirmed.
   *    "Is this handle free?" is answered by the public `/handle/:handle`.
   *  - A swap from nothing refuses to replace a live pending entry, so a
   *    second begin for someone's address cannot take over the request their
   *    link belongs to; of two begins at once, one parks and the other sends
   *    nothing.
   *  - `previous`, the request and claim secret of a sign-up this tab began
   *    before, retires that request and frees its address first, so a person
   *    who goes back to fix their handle can begin again at once. Without the
   *    claim secret it retires nothing.
   *  - The pending store is self-bounding (CEREMONY_STORE_MAX in memory,
   *    per-entry TTL on the Durable Object store).
   *  - The local-only debug line with the link is gated on `OSN_ENV` being
   *    unset or `"local"`.
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
    previous?: { readonly requestId: string; readonly claimSecret: string },
  ): Effect.Effect<
    { requestId: string; claimSecret: string; pairingCode: string; expiresAt: number },
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
      // collected — before the link is sent and before we even probe for
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

      if (previous) {
        yield* links.retire("registration", previous.requestId, previous.claimSecret);
      }

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

      // The user can use the login flow if they already have an account; we
      // don't confirm or deny their existence over an unauthenticated channel.
      const taken = collision.length > 0;

      // A taken address parks at its probe key, which no live sign-up uses,
      // and its pending entry holds no address, so nothing is ever mailed for
      // it and no claim can finish it.
      const key = taken ? serverMac.probeKey(normalisedEmail) : normalisedEmail;
      const ttlMs = otpTtl * 1000;
      const opened = yield* links.open("registration", key, ttlMs);
      const parked: PendingRegistration = taken
        ? {
            email: "",
            handle: "",
            displayName: null,
            requestId: opened.requestId,
            expiresAt: opened.expiresAt,
          }
        : {
            email: normalisedEmail,
            handle,
            displayName: displayName ?? null,
            requestId: opened.requestId,
            expiresAt: opened.expiresAt,
          };
      const written = yield* storeCall(stores.pendingRegistrations, "swap", () =>
        stores.pendingRegistrations.swap(key, null, parked, ttlMs),
      );
      const answer = {
        requestId: opened.requestId,
        claimSecret: opened.claimSecret,
        pairingCode: opened.pairingCode,
        expiresAt: Math.floor(opened.expiresAt / 1000),
      };
      // A request whose entry did not park is left to expire unconfirmed: its
      // link is never sent.
      if (taken || !written) return answer;

      yield* logDevLink("registration", opened.url);

      // The send runs after the answer, forked with a timeout. Awaiting it
      // would make this branch answer a mail round trip later than the taken
      // and pending branches, and the response time would say whether the
      // address has an account. `forkBackground` registers the fibre with the
      // request's `waitUntil`, so the send still runs on workerd once the
      // response is out.
      yield* forkBackground(sendLink(normalisedEmail, handle, opened.url, otpTtl / 60, "first"));

      return answer;
    }).pipe(withAuthRegister("begin"));

  /**
   * Sends another link for a sign-up, to the tab that holds its claim secret.
   * Every link sent stays usable until the request ends; at most
   * `EMAIL_LINK_MAX_SENDS` in all. Answers:
   *
   *  - `sent` — another link is on its way; also for a taken address's request
   *    (nothing goes out) and for a request already confirmed (the next poll
   *    finishes it, so nothing more is needed);
   *  - `limit` — the request has sent all the links it may;
   *  - `expired` — no live request matches.
   *
   * Like begin, it mails after the answer, and a taken address's request makes
   * the same store calls as a free one's.
   */
  const resendRegistration = (
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<{ status: "sent" | "limit" | "expired" }, CoordinationError, EmailService> =>
    Effect.gen(function* () {
      const resent = yield* links.resend("registration", requestId, claimSecret);
      if (resent.state === "expired") return { status: "expired" } as const;
      if (resent.state === "limit") return { status: "limit" } as const;
      if (resent.state === "confirmed") return { status: "sent" } as const;
      const pending = yield* storeCall(stores.pendingRegistrations, "get", () =>
        stores.pendingRegistrations.get(resent.subject),
      );
      if (pending?.requestId === requestId && pending.email) {
        const minutesLeft = Math.max(1, Math.ceil((resent.expiresAt - Date.now()) / 60_000));
        yield* logDevLink("registration", resent.url);
        yield* forkBackground(
          sendLink(pending.email, pending.handle, resent.url, minutesLeft, "resend"),
        );
      }
      return { status: "sent" } as const;
    }).pipe(withAuthRegister("resend"));

  /**
   * Creates the account for a confirmed request and signs in the caller — the
   * tab that holds the claim secret. The claim takes the request first, so of
   * two polls at once exactly one gets here.
   *
   *  - The pending entry must still name this request and hold an address; a
   *    taken address's never does.
   *  - Insert relies on the DB-level UNIQUE constraints on email/handle as the
   *    source of truth. A uniqueness violation (the handle went to someone
   *    else while the person waited) fails as a conflict, and the pending
   *    entry goes, so the person can begin again with another handle. Any
   *    other failure puts the request back and keeps the pending entry, so the
   *    next poll can try again.
   *  - The pending entry is removed after the answer: the account exists
   *    whatever happens to that call, and an entry left behind expires.
   */
  const finishRegistration = (
    requestId: string,
    link: EmailLinkChallenge,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<RegistrationStatus, AuthError | DatabaseError | CoordinationError, Db> =>
    Effect.gen(function* () {
      const pending = yield* storeCall(stores.pendingRegistrations, "get", () =>
        stores.pendingRegistrations.get(link.subject),
      );
      if (pending?.requestId !== requestId || !pending.email) {
        return { status: "expired" } as const;
      }
      const claimed = yield* links.claim(requestId, link);
      if (!claimed) return { status: "expired" } as const;

      const { db } = yield* Db;
      const accountId = genId("acc_");
      const id = genId("usr_");
      const ts = now();

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
            if (UNIQUE_CONSTRAINT_ERROR.test(driverErrorText(e))) {
              return { ok: false as const };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(Effect.tapError(() => links.unclaim(requestId, link).pipe(Effect.ignore)));

      const tidy = forkBackground(
        spendEntry(stores.pendingRegistrations, link.subject, pending).pipe(Effect.ignore),
      );

      if (!inserted.ok) {
        yield* tidy;
        return yield* Effect.fail(
          new AuthError({
            message: "Email or handle already registered",
            metricResult: "conflict",
          }),
        );
      }

      yield* tidy;

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
        status: "complete",
        profileId: id,
        handle: pending.handle,
        email: pending.email,
        displayName: pending.displayName,
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresIn: issued.expiresIn,
      } as const;
    }).pipe(withAuthRegister("complete"));

  /**
   * Step 2 of sign-up, polled by the tab that began with its claim secret.
   * Answers `pending` until the link is confirmed, then creates the account
   * and answers `complete` with a session, once. `expired` for every refusal:
   * an unknown or expired request, a wrong claim secret, or a poll that lost
   * the claim to another. `conflict` when the handle was taken while the
   * person waited.
   *
   * The UI then drives `/passkey/register/*` with the returned access token to
   * enrol the first passkey, and refuses to dismiss until it does;
   * `deletePasskey` refuses to drop below 1 — so every live account always has
   * ≥1 passkey.
   *
   * No attempts counter: a waiting tab polls every few seconds and would bury
   * the sign-up funnel. The span is `auth.register.status`; the finishing part
   * counts as the funnel's `complete` step.
   */
  const registrationStatus = (
    requestId: string,
    claimSecret: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<RegistrationStatus, AuthError | DatabaseError | CoordinationError, Db> =>
    Effect.gen(function* () {
      const polled = yield* links.poll("registration", requestId, claimSecret);
      if (polled.state === "pending") return { status: "pending" } as const;
      if (polled.state === "expired") return { status: "expired" } as const;
      return yield* finishRegistration(requestId, polled.entry, sessionMeta).pipe(
        Effect.catchTag("AuthError", (e) =>
          e.metricResult === "conflict"
            ? Effect.succeed({ status: "conflict" } as const)
            : Effect.fail(e),
        ),
      );
    }).pipe(Effect.withSpan("auth.register.status"));

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
    resendRegistration,
    registrationStatus,
    checkHandle,
  };
}
