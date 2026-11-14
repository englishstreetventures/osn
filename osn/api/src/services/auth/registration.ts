/**
 * Account creation: the legacy direct `registerProfile`, sign-up through an
 * emailed link (begin, resend, status), and the public handle-availability
 * check.
 */

import { accounts, organisations, users } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { commitBatch, driverErrorText, rowsChanged } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import { and, eq, notExists, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect, Schema } from "effect";

import { forkBackground } from "../../lib/background";
import { canBatch } from "../../lib/batch";
import { bound } from "../../lib/bound";
import { handleArms, heldHandleRow } from "../../lib/handle-hold";
import { UNIQUE_CONSTRAINT_ERROR } from "../../lib/unique-constraint";
import { metricAuthHandleCheck, metricEmailLinkSend, withAuthRegister } from "../../metrics";
import { spendEntry } from "./attempts";
import { isReservedHandle, MIN_AGE_YEARS } from "./constants";
import type { AuthContext } from "./context";
import type { EmailLinkModule } from "./email-link";
import type { EmailVerificationInput, EmailVerificationModule } from "./email-verification-token";
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
  mailboxKey,
  now,
} from "./helpers";
import type { ProfilesModule } from "./profiles";
import { storeCall } from "./store-call";
import type {
  EmailLinkChallenge,
  EmailLinkClaim,
  PendingRegistration,
  PendingSignUp,
} from "./stores";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, SessionMeta } from "./types";

/**
 * What a taken address's request parks: no address and no handle, so nothing
 * is ever mailed for it and no claim can finish it. A request that carries no
 * sign-up parks the same.
 */
const DECOY_SIGN_UP: PendingSignUp = { email: "", handle: "", displayName: null };

/** What a sign-up status poll answers. */
export type RegistrationStatus =
  | {
      readonly status: "pending";
      /** The number the waiting screen shows, for a tab that has lost it. */
      readonly pairingCode?: string;
    }
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
  emailVerification: EmailVerificationModule,
) {
  const {
    config,
    stores,
    otpTtl,
    serverMac,
    heldHandleDigest,
    registrationSendCap,
    registrationLinkLockoutStore,
    registrationFirstLinkCap,
  } = ctx;
  const { issueTokens } = tokens;

  /**
   * An `'email'` row if an account has `email`, and a `'handle'` row for each
   * of {@link handleArms}: one UNION ALL of four terms, within D1's limit of
   * five (`wiki/shared/d1-limits.md`).
   */
  const collisionProbe = (db: DbService["db"], email: string, handle: string) =>
    unionAll(
      db
        .select({ field: sql<string>`'email'`.as("field") })
        .from(accounts)
        .where(eq(accounts.email, email)),
      ...handleArms(db, heldHandleDigest, handle),
    );

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

      if (isReservedHandle(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      const { db } = yield* Db;
      const collisions = yield* Effect.tryPromise({
        try: () => collisionProbe(db, email, handle),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // The email error takes priority.
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
   * Whether an account has `email`, or `handle` is taken or held (see
   * {@link handleArms}), in one round trip. Answers the same for either.
   */
  const isTaken = (email: string, handle: string): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const collision = yield* Effect.tryPromise({
        try: () => collisionProbe(db, email, handle),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return collision.length > 0;
    });

  /**
   * Mails the sign-up link for `handle` to `address`, after the answer: the
   * caller forks it. Everything it reads costs the answer nothing. The mail
   * goes to `address` as typed:
   *
   *  - no link goes while an account has the address or the handle is taken
   *    or held — begin's probe, run again here, first, because the request may
   *    have parked since begin ran it: a request that found the address held
   *    parks on a Resend once the sign-up holding it ends, and that sign-up
   *    may have ended by making the account. So the limits below are reached
   *    only where a link goes out, never for a taken address;
   *  - no link goes to an address whose sign-up links drew three wrong picks
   *    today, counted under the address exactly as typed, lowercased;
   *  - a Resend's link counts against the hourly cap of the address's
   *    mailbox (`mailboxKey`: every `+tag` variant of a local part shares
   *    one), and goes no further past it. A begin's first link does not
   *    count, so the newest sign-up always gets its first link whatever
   *    Resends came before it;
   *  - a begin's first link counts against the mailbox's first-link window
   *    (`registrationFirstLinkCap`, the same mailbox key), and goes no further
   *    past it, whatever form of the address was typed. The mailbox's first
   *    link of the hour is the window's first count, so it always goes. A
   *    begin that carried `previous`, or that follows a decline, is a first
   *    link like any other and counts the same.
   *
   * The probe or either store failing to answer sends nothing. A held-back
   * or failed send is counted and goes no further; the transport has already
   * logged why a send failed. The request stays live either way, and Resend
   * on it is the retry.
   */
  const sendLink = (
    address: string,
    handle: string,
    url: string,
    ttlMinutes: number,
    kind: "first" | "resend",
  ) =>
    Effect.gen(function* () {
      const standing = yield* isTaken(address, handle).pipe(
        Effect.map((taken) => (taken ? "taken" : "free")),
        // The driver's error carries the query's parameters, the address
        // among them, so it is not logged.
        Effect.catchTag("DatabaseError", () => Effect.succeed("unknown" as const)),
      );
      if (standing === "taken") {
        metricEmailLinkSend("registration", "taken");
        return;
      }
      if (standing === "unknown") {
        metricEmailLinkSend("registration", "failed");
        yield* Effect.logError("sign-up link not sent: the account probe failed");
        return;
      }
      const strikeKey = serverMac.probeKey(address.toLowerCase());
      const capKey = serverMac.probeKey(mailboxKey(address));
      const strikes = yield* Effect.promise(() => registrationLinkLockoutStore.status(strikeKey));
      const cap = kind === "resend" ? registrationSendCap : registrationFirstLinkCap;
      const allowed = strikes.status === "open" && (yield* Effect.promise(() => cap.check(capKey)));
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
   * Answers `{ requestId, claimSecret, retireSecret, pairingCode, expiresAt }`
   * to the tab that began. The tab keeps the claim secret and polls
   * `registrationStatus` with it, and shows the pairing code, which the
   * confirm step requires; the link goes only to the address. The retire
   * secret can only end the request, as a later begin's `previous`: no poll,
   * Resend or confirm accepts it.
   *
   * Security properties:
   *  - Every branch — the address or handle taken, a sign-up already pending
   *    for the address, a link sent — answers the same shape after the same
   *    two store calls (the link request's write, then a swap from nothing on
   *    the pending entry), and mails after the answer. Neither the body, the
   *    status nor the time to answer says whether an address has an account.
   *    A taken address gets a request whose link is never sent. Its poll and
   *    Resend answer as a free address's do while nobody acts on the free
   *    one's link: `pending` and `sent` until the request expires.
   *    "Is this handle free?" is answered by the public `/handle/:handle`.
   *  - A swap from nothing refuses to replace a live pending entry, so a
   *    second begin for someone's address cannot take over the request their
   *    link belongs to unless it carries that request's retire secret; of two
   *    begins at once, one parks and the other sends nothing until a Resend
   *    finds the address free.
   *  - `previous`, the request and retire secret of a sign-up begun before in
   *    this browser, retires that request and frees its address first when
   *    it is for the address this begin is for, so a person who goes back to
   *    fix their handle, or starts again from another tab, can begin again
   *    at once. The browser keeps the retire secret where every tab and
   *    every user of it can read it, so it is held to ending one request, for
   *    a begin for that request's address; the new request's link still needs
   *    its number picked, and wrong picks count against the address. A wrong
   *    retire secret, the claim secret in its place, an
   *    unknown request or one for another address retires nothing, costs the
   *    one read and answers as a begin with no `previous` does, alike. Its
   *    first link counts against the mailbox's first-link window as every
   *    begin's does.
   *  - The pending store is self-bounding (CEREMONY_STORE_MAX in memory,
   *    per-entry TTL on the Durable Object store).
   *  - The local-only debug line with the link is gated on `OSN_ENV` being
   *    unset or `"local"`.
   *  - `emailVerification`, a browser Email Verification API token with the
   *    tab's nonce secret, is read only while the flag is on
   *    (`config.emailVerification`). It is checked after the age gate and the
   *    handle checks and before the taken probe, so every address pays the
   *    same lookups. One that verifies makes one more write on the request
   *    whatever the address: a free address's request is confirmed then, as
   *    its link would be, and nothing is mailed; a taken or held one's is
   *    written back unchanged and goes on exactly as without a token. Any
   *    refusal is silent: the link path runs. The account is still made by
   *    the status poll, and the first passkey after it.
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
    previous?: { readonly requestId: string; readonly retireSecret: string },
    emailVerificationInput?: EmailVerificationInput,
  ): Effect.Effect<
    {
      requestId: string;
      claimSecret: string;
      retireSecret: string;
      pairingCode: string;
      expiresAt: number;
    },
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

      if (isReservedHandle(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      // Normalise email to lowercase — the canonical form is what we
      // persist and what we key the pending-registrations map by.
      const normalisedEmail = email.toLowerCase();

      if (previous) {
        // Only a request for the address typed now is retired: its parked
        // address, or a taken address's probe key, keyed as this begin's.
        const typedKey = serverMac.probeKey(normalisedEmail);
        yield* links.retire("registration", previous.requestId, previous.retireSecret, (entry) => {
          const parked = entry.signUp?.email ?? "";
          const parkedKey = serverMac.probeKey(parked);
          return timingSafeEqualString(parked === "" ? entry.subject : parkedKey, typedKey);
        });
      }

      // A browser's proof that the person controls the address, checked
      // before the taken probe so a taken and a free address cost the same.
      const verified = emailVerificationInput
        ? yield* emailVerification.verify(normalisedEmail, emailVerificationInput)
        : false;

      // The user can use the login flow if they already have an account; we
      // don't confirm or deny their existence over an unauthenticated channel.
      // The taken branch below responds identically for the address or the
      // handle, so no per-field distinction is needed.
      const taken = yield* isTaken(normalisedEmail, handle);

      // A taken address parks at its probe key, which no live sign-up uses,
      // and its pending entry holds no address, so nothing is ever mailed for
      // it and no claim can finish it.
      const key = taken ? serverMac.probeKey(normalisedEmail) : normalisedEmail;
      const ttlMs = otpTtl * 1000;
      const signUp: PendingSignUp = taken
        ? DECOY_SIGN_UP
        : { email: normalisedEmail, handle, displayName: displayName ?? null };
      // The request carries the sign-up too, so a begin that finds the
      // address held can park it on a Resend once the address is free.
      const opened = yield* links.openRetirable("registration", key, ttlMs, { signUp });
      const parked: PendingRegistration = {
        ...signUp,
        requestId: opened.requestId,
        expiresAt: opened.expiresAt,
      };
      const written = yield* storeCall(stores.pendingRegistrations, "swap", () =>
        stores.pendingRegistrations.swap(key, null, parked, ttlMs),
      );
      const answer = {
        requestId: opened.requestId,
        claimSecret: opened.claimSecret,
        retireSecret: opened.retireSecret,
        pairingCode: opened.pairingCode,
        expiresAt: Math.floor(opened.expiresAt / 1000),
      };
      // A verified begin confirms a free address's request now, and writes a
      // taken or held one's back unchanged, so all three make this call.
      if (verified && (yield* links.markVerified(opened, !taken && written))) return answer;
      // A request whose entry did not park sends no link now; its Resend
      // parks it once the address is free.
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
   *    (nothing goes out), for a request whose address another live sign-up
   *    holds or an account has taken since begin (nothing goes out), for a
   *    request its link's reader ended (nothing goes out: the tab is answered
   *    as a taken address's would be), and for a request already confirmed
   *    (the next poll finishes it, so nothing more is needed);
   *  - `limit` — the request has sent all the links it may;
   *  - `expired` — no live request matches.
   *
   * A request whose begin found the address held parks its sign-up here, by a
   * swap from nothing, once the sign-up that held it has ended; its link then
   * goes, unless an account has the address or the handle by then (the send
   * checks). Every request makes that swap, which cannot win where an entry is
   * live, so a free address's request, a taken one's and a held one's make the
   * same store calls. A request its reader ended parks a decoy at the probe
   * key of its subject instead, never at the address, so it never holds a
   * free address again; that swap is the same call. Like begin, it mails
   * after the answer.
   *
   * A request that parks at an address an account has since taken stays
   * parked. Its entry blocks nobody: while an account has the address, every
   * begin for it parks at the address's probe key instead. No link was mailed
   * for it, so nothing can confirm it, and it ends at its own expiry or when
   * retired, declined or wiped. Should the account give the address up
   * meanwhile, this request is the address's live sign-up, and its next
   * Resend mails as any free address's does.
   */
  const resendRegistration = (
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<
    { status: "sent" | "limit" | "expired" },
    CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const resent = yield* links.resend("registration", requestId, claimSecret);
      if (resent.state === "expired") return { status: "expired" } as const;
      if (resent.state === "limit") return { status: "limit" } as const;
      if (resent.state === "confirmed") return { status: "sent" } as const;
      const key = resent.ended ? serverMac.probeKey(resent.subject) : resent.subject;
      const parked: PendingRegistration = {
        ...(resent.ended ? DECOY_SIGN_UP : (resent.signUp ?? DECOY_SIGN_UP)),
        requestId,
        expiresAt: resent.expiresAt,
      };
      yield* storeCall(stores.pendingRegistrations, "swap", () =>
        stores.pendingRegistrations.swap(
          key,
          null,
          parked,
          Math.max(1, resent.expiresAt - Date.now()),
        ),
      );
      const pending = yield* storeCall(stores.pendingRegistrations, "get", () =>
        stores.pendingRegistrations.get(key),
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
   * Inserts the account and default profile a claim names, with the sign-up
   * it parked. True when they are in place after the call: inserted now, or
   * already committed by an earlier try for the same claim. False when they
   * are not this claim's own and either a UNIQUE index refused them for
   * someone else's account, or the guard below wrote nothing because the
   * handle is held or an organisation has it. False, writing nothing, for a
   * reserved handle: a sign-up begun before a name was reserved is refused
   * here. Any other failure is a DatabaseError.
   *
   * Both inserts are `INSERT … SELECT` under the same guard: no live hold on
   * the handle and no organisation with it. `users.handle` is UNIQUE, but
   * neither a hold nor an organisation is a `users` row, so without the
   * guard either could take the handle between begin and this call and the
   * account would still be created. On D1 the two inserts commit together and
   * read the guard in one transaction, so both rows land or neither does;
   * bun:sqlite, local only, runs them one after the other.
   */
  const insertClaimed = (
    claim: Pick<EmailLinkClaim, "accountId" | "profileId">,
    signUp: PendingSignUp,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      if (isReservedHandle(signUp.handle)) return false;
      const { db } = yield* Db;
      const ts = now();
      const handleFree = and(
        notExists(
          heldHandleRow(db, heldHandleDigest, signUp.handle, Math.floor(Date.now() / 1000)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(organisations)
            .where(eq(organisations.handle, signUp.handle)),
        ),
      );
      const account = db.insert(accounts).select(
        db
          .select({
            id: bound(claim.accountId, accounts.id),
            email: bound(signUp.email, accounts.email),
            passkeyUserId: bound(crypto.randomUUID(), accounts.passkeyUserId),
            maxProfiles: bound(5, accounts.maxProfiles),
            createdAt: bound(ts, accounts.createdAt),
            updatedAt: bound(ts, accounts.updatedAt),
          })
          .from(sql`(SELECT 1)`)
          .where(handleFree),
      );
      // Selected from the account row this claim names, so a profile is never
      // written without its account.
      const profile = db.insert(users).select(
        db
          .select({
            id: bound(claim.profileId, users.id),
            accountId: bound(claim.accountId, users.accountId),
            handle: bound(signUp.handle, users.handle),
            displayName: bound(signUp.displayName, users.displayName),
            isDefault: bound(true, users.isDefault),
            createdAt: bound(ts, users.createdAt),
            updatedAt: bound(ts, users.updatedAt),
          })
          .from(accounts)
          .where(and(eq(accounts.id, claim.accountId), handleFree)),
      );
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const [, inserted] = canBatch(db)
              ? await db.batch([account, profile])
              : ([await account, await profile] as const);
            if (rowsChanged(inserted) > 0) return true;
          } catch (e) {
            if (!UNIQUE_CONSTRAINT_ERROR.test(driverErrorText(e))) throw e;
          }
          // The claim's ids are random and fixed when it was made, so a
          // profile under them is this request's own, from an earlier try.
          const own = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, claim.profileId), eq(users.accountId, claim.accountId)))
            .limit(1);
          return own.length > 0;
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  /**
   * Creates the account for a confirmed request and signs in the caller — the
   * tab that holds the claim secret — or finishes a request an earlier poll
   * claimed and could not finish.
   *
   *  - The first claim needs the pending entry to still name this request and
   *    hold an address; a taken address's never does. It fixes the account
   *    and profile ids every later try uses. Of two polls at once one claims
   *    it, and the other answers `expired`, as does a poll that finds the
   *    request held by another poll.
   *  - Insert relies on the DB-level UNIQUE constraints on email/handle as the
   *    source of truth. A clash with rows an earlier try for this claim
   *    committed goes on to the session. A clash with someone else's account
   *    (the handle went to someone else while the person waited) ends the
   *    request and frees the pending entry, and fails as a conflict, so the
   *    person can begin again with another handle.
   *  - The session is answered only once this poll has spent the request, so
   *    of all the polls that ever hold it exactly one delivers. Any failure
   *    before that keeps the claim and lets go of it, so the next poll takes
   *    over at once and finishes on the same account.
   *  - The pending entry is removed after the answer: the account exists
   *    whatever happens to that call, and an entry left behind expires.
   */
  const finishRegistration = (
    requestId: string,
    link: EmailLinkChallenge,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<RegistrationStatus, AuthError | DatabaseError | CoordinationError, Db> =>
    Effect.gen(function* () {
      const signUp = link.signUp;
      const pending = yield* storeCall(stores.pendingRegistrations, "get", () =>
        stores.pendingRegistrations.get(link.subject),
      );
      const parkedHere = pending?.requestId === requestId;
      // A claimed request passed this check when it was claimed; its pending
      // entry going since does not stop it finishing.
      const parked = link.status === "claimed" || (parkedHere && pending.email !== "");
      if (!signUp?.email || !parked) return { status: "expired" } as const;
      const claimed = yield* links.claim(requestId, link, {
        accountId: genId("acc_"),
        profileId: genId("usr_"),
      });
      if (!claimed) return { status: "expired" } as const;
      const { accountId, profileId } = claimed.claim;

      const finished = yield* Effect.gen(function* () {
        if (!(yield* insertClaimed(claimed.claim, signUp))) {
          yield* links.spend(requestId, claimed);
          return { kind: "conflict" } as const;
        }
        // The account was created just now, so no deletion is pending.
        const issued = yield* issueTokens(
          profileId,
          accountId,
          signUp.email,
          signUp.handle,
          signUp.displayName,
          undefined,
          sessionMeta,
          null,
        );
        if (!(yield* links.spend(requestId, claimed))) return { kind: "lost" } as const;
        return { kind: "complete", issued } as const;
      }).pipe(Effect.tapError(() => links.letGo(requestId, claimed).pipe(Effect.ignore)));

      // Another poll took the request over and delivers it.
      if (finished.kind === "lost") return { status: "expired" } as const;

      if (parkedHere) {
        yield* forkBackground(
          spendEntry(stores.pendingRegistrations, link.subject, pending).pipe(Effect.ignore),
        );
      }

      if (finished.kind === "conflict") {
        return yield* Effect.fail(
          new AuthError({
            message: "Email or handle already registered",
            metricResult: "conflict",
          }),
        );
      }

      return {
        status: "complete",
        profileId,
        handle: signUp.handle,
        email: signUp.email,
        displayName: signUp.displayName,
        accessToken: finished.issued.accessToken,
        refreshToken: finished.issued.refreshToken,
        expiresIn: finished.issued.expiresIn,
      } as const;
    }).pipe(withAuthRegister("complete"));

  /**
   * Step 2 of sign-up, polled by the tab that began with its claim secret.
   * Answers `pending` until the link is confirmed, with the request's number
   * so a reloaded tab can show it again without keeping it, then creates the
   * account and answers `complete` with a session, once. `expired` for every refusal:
   * an unknown or expired request, a wrong claim secret, or a poll that lost
   * the claim to another or found another holding it. `conflict` when the
   * handle was taken while the person waited. A poll that fails after the
   * claim leaves the request claimed, and the next one finishes it.
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
      if (polled.state === "pending") {
        return { status: "pending", pairingCode: polled.pairingCode } as const;
      }
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
   * Checks whether a handle is valid format, not reserved, and not taken or
   * held: available exactly when sign-up would accept it.
   */
  const checkHandle = (
    handle: string,
  ): Effect.Effect<{ available: boolean }, ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(HandleSchema)(handle).pipe(
        Effect.tapError(() => Effect.sync(() => metricAuthHandleCheck("invalid"))),
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (isReservedHandle(handle)) {
        metricAuthHandleCheck("taken");
        return { available: false };
      }
      // Availability only needs existence: one round trip over the three
      // single-column arms, with no account join. Keeps this high-frequency,
      // debounced endpoint as light as possible.
      const { db } = yield* Db;
      const existing = yield* Effect.tryPromise({
        try: () => unionAll(...handleArms(db, heldHandleDigest, handle)),
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
