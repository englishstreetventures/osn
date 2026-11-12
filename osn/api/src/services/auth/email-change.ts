/**
 * Email change (step-up gated). A link to the NEW address proves the new
 * inbox; then the tab that began, holding a step-up token for `email_change`,
 * moves the account to it. 2-per-7-days hard cap; the move, its audit row and
 * the revocation of every other session commit together.
 */

import { accounts, emailChanges, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { driverErrorText, rowsChanged } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import type { SecurityEventKind } from "@shared/observability/metrics";
import { and, count as countFn, eq, exists, gte, lt, notExists, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { forkBackground } from "../../lib/background";
import { canBatch } from "../../lib/batch";
import { bound } from "../../lib/bound";
import { UNIQUE_CONSTRAINT_ERROR } from "../../lib/unique-constraint";
import {
  metricEmailLinkSend,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withEmailChange,
} from "../../metrics";
import type { AuthContext } from "./context";
import type { EmailLinkModule } from "./email-link";
import { AuthError, type CoordinationError, DatabaseError, ValidationError } from "./errors";
import { EmailSchema, genId, logDevLink, mailboxKey } from "./helpers";
import type { SecurityEventsModule } from "./security-events";
import { outsideFamilyOf } from "./sessions";
import type { StepUpModule } from "./step-up";
import { storeCall } from "./store-call";
import type { SessionMeta } from "./types";

/** What `POST /account/email/begin` answers the tab that began, on every branch. */
export interface EmailChangeBegun {
  readonly requestId: string;
  readonly claimSecret: string;
  /** The number the tab shows, which the reader picks on the link's page. */
  readonly pairingCode: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** What an email change's status poll answers. `confirmed` is not a claim: complete claims. */
export type EmailChangeStatus =
  | { readonly status: "pending"; readonly pairingCode?: string }
  | { readonly status: "confirmed" }
  | { readonly status: "expired" };

const EXPIRED = { status: "expired" } as const;

/**
 * The id of the `email_changed` security event a change records: derived from
 * the change's own id, so a retry that finds the change on record can write a
 * missing event without ever writing a second one.
 */
const eventIdOf = (changeId: string): string => `sev_${changeId.slice("ech_".length)}`;

/** Every refusal of a request a complete names: unknown, unconfirmed, spent, replaced, another's. */
const LINK_REFUSED = "Invalid or expired link";

export function createEmailChangeModule(
  ctx: AuthContext,
  stepUp: StepUpModule,
  links: EmailLinkModule,
  securityEventsModule: SecurityEventsModule,
) {
  const {
    config,
    stores,
    otpTtl,
    serverMac,
    hashIp,
    emailChangeBeginCap,
    linkResendCap,
    registrationLinkLockoutStore,
  } = ctx;
  const { verifyStepUpForEmailChange } = stepUp;

  const EMAIL_CHANGE_LIMIT = 2;
  const EMAIL_CHANGE_WINDOW_SECONDS = 7 * 24 * 60 * 60;
  const linkTtlMinutes = otpTtl / 60;

  /**
   * The keyed digest of an address: the request's `bound`, and the key wrong
   * picks count under — the same key sign-up's links to that address use.
   */
  const addressDigest = (address: string): string =>
    serverMac.probeKey(address.trim().toLowerCase());

  /**
   * Whether an account holds `address`: one query, projecting the indexed
   * column alone so UNIQUE(email) answers it from the index.
   */
  const addressTaken = (address: string): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ email: accounts.email })
            .from(accounts)
            .where(eq(accounts.email, address))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows.length > 0;
    });

  /** Changes on record for `accountId` since `windowStart` (unix seconds). */
  const changesSince = (
    accountId: string,
    windowStart: number,
  ): Effect.Effect<number, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      return yield* Effect.tryPromise({
        try: async () => {
          const [row] = await db
            .select({ count: countFn() })
            .from(emailChanges)
            .where(
              and(
                eq(emailChanges.accountId, accountId),
                gte(emailChanges.completedAt, windowStart),
              ),
            );
          return Number(row?.count ?? 0);
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  /**
   * Mails an email-change link to the new `address`, after the answer: the
   * caller forks it, so the send adds nothing to the time to answer. No link
   * goes to an address whose link lockout holds (wrong picks on links to it,
   * sign-up's and this flow's alike), and a Resend's link counts against the
   * mailbox's Resends a day; a begin's first link never does. A held-back or
   * failed send is counted and goes no further; Resend is the retry.
   */
  const sendEmailChangeLink = (
    address: string,
    url: string,
    ttlMinutes: number,
    kind: "first" | "resend",
  ): Effect.Effect<void, never, EmailService> =>
    Effect.gen(function* () {
      const strikes = yield* Effect.promise(() =>
        registrationLinkLockoutStore.status(addressDigest(address)),
      );
      const allowed =
        strikes.status === "open" &&
        (kind === "first" ||
          (yield* Effect.promise(() =>
            linkResendCap.check(`email_change:${serverMac.probeKey(mailboxKey(address))}`),
          )));
      if (!allowed) {
        metricEmailLinkSend("email_change", "capped");
        return;
      }
      const emailSvc = yield* EmailService;
      yield* emailSvc
        .send({
          template: "link-email-change",
          to: address,
          data: { url, ttlMinutes, instanceName: config.instanceName },
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.tap(() => Effect.sync(() => metricEmailLinkSend("email_change", "sent"))),
          Effect.catch(() => Effect.sync(() => metricEmailLinkSend("email_change", "failed"))),
        );
    }).pipe(Effect.withSpan("auth.account.email_change.link_send"));

  /**
   * `POST /account/email/begin` — opens an email change to `newEmail` and
   * mails a link there, after the answer.
   *
   * Refusals that depend only on the caller come first and say why: a
   * malformed address, the per-account cap on begins, the account's own
   * address, the 2-per-7-days cap. Past them, a taken address and a free one
   * make the same calls and get the same answer — one collision probe, one
   * request opened, the account's pending change replaced — and only a free
   * address is mailed. The taken one's link secret goes nowhere, so its
   * request can never be confirmed; its poll stays `pending` until it expires.
   * An authenticated caller must not learn whether another account owns an
   * address, and UNIQUE(email) at complete is the defence against a race.
   */
  const beginEmailChange = (
    accountId: string,
    newEmail: string,
  ): Effect.Effect<
    EmailChangeBegun,
    AuthError | ValidationError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(EmailSchema)(newEmail).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      const normalised = newEmail.toLowerCase();
      const { db } = yield* Db;

      // Per-account cap beneath the per-IP rate limit, so a caller behind
      // rotating addresses cannot pool their allowance to mail arbitrary
      // inboxes from the sending domain.
      const emailChangeAllowed = yield* Effect.promise(() => emailChangeBeginCap.check(accountId));
      if (!emailChangeAllowed) {
        return yield* Effect.fail(new AuthError({ message: "Too many email change attempts" }));
      }

      const currentAccount = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ email: accounts.email })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = currentAccount[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      if (account.email === normalised) {
        return yield* Effect.fail(new AuthError({ message: "New email matches current email" }));
      }

      // Before the collision probe: a capped caller must not be able to tell
      // a taken address from a free one by which check fails first.
      const windowStart = Math.floor(Date.now() / 1000) - EMAIL_CHANGE_WINDOW_SECONDS;
      if ((yield* changesSince(accountId, windowStart)) >= EMAIL_CHANGE_LIMIT) {
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }

      const taken = yield* addressTaken(normalised);
      const opened = yield* links.open("email_change", accountId, otpTtl * 1000, {
        bound: addressDigest(normalised),
      });
      yield* storeCall(stores.pendingEmailChanges, "set", () =>
        stores.pendingEmailChanges.set(
          accountId,
          { newEmail: normalised, requestId: opened.requestId, expiresAt: opened.expiresAt },
          otpTtl * 1000,
        ),
      );
      if (!taken) {
        // Inert unless the runtime tier is `local`.
        yield* logDevLink("email-change", opened.url);
        yield* forkBackground(sendEmailChangeLink(normalised, opened.url, linkTtlMinutes, "first"));
      }
      return {
        requestId: opened.requestId,
        claimSecret: opened.claimSecret,
        pairingCode: opened.pairingCode,
        expiresAt: Math.floor(opened.expiresAt / 1000),
      };
    }).pipe(withEmailChange("begin"));

  /**
   * `POST /account/email/:requestId/status` — polled by the tab that began,
   * signed in as the account that began. `pending` (with the number) until
   * the new address's link is confirmed, then `confirmed`, which claims
   * nothing: the tab steps up and completes. A request the link's reader
   * ended stays `pending` until it expires, as a taken address's does.
   * `expired` for every refusal.
   */
  const emailChangeStatus = (
    accountId: string,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<EmailChangeStatus, CoordinationError> =>
    Effect.gen(function* () {
      const polled = yield* links.poll("email_change", requestId, claimSecret, accountId);
      if (polled.state === "confirmed") return { status: "confirmed" } as const;
      if (polled.state === "expired") return EXPIRED;
      return polled.pairingCode === undefined
        ? ({ status: "pending" } as const)
        : ({ status: "pending", pairingCode: polled.pairingCode } as const);
    }).pipe(Effect.withSpan("auth.account.email_change.status"));

  /**
   * `POST /account/email/:requestId/resend` — another link for the same
   * request. Answers as begin does whether the address is taken or free: the
   * pending change and the collision probe are read on every branch, and a
   * link goes only to a free address the account's pending change still
   * names for this request, while its link's reader has not ended it.
   */
  const resendEmailChange = (
    accountId: string,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<
    { status: "sent" | "limit" | "expired" },
    DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const resent = yield* links.resend("email_change", requestId, claimSecret, accountId);
      if (resent.state === "expired") return EXPIRED;
      if (resent.state === "limit") return { status: "limit" } as const;
      if (resent.state === "confirmed") return { status: "sent" } as const;
      const pending = yield* storeCall(stores.pendingEmailChanges, "get", () =>
        stores.pendingEmailChanges.get(accountId),
      );
      const address = pending?.requestId === requestId ? pending.newEmail : null;
      const taken = yield* addressTaken(address ?? "");
      if (!resent.ended && address !== null && !taken && resent.bound === addressDigest(address)) {
        const minutesLeft = Math.max(1, Math.ceil((resent.expiresAt - Date.now()) / 60_000));
        yield* logDevLink("email-change", resent.url);
        yield* forkBackground(sendEmailChangeLink(address, resent.url, minutesLeft, "resend"));
      }
      return { status: "sent" } as const;
    }).pipe(withEmailChange("resend"));

  /**
   * Moves `accountId` from `previousEmail` to `newEmail`: the account row, the
   * change on record (as `changeId`), the revocation of every session but the
   * caller's device, and an `email_changed` security event, as one D1 batch;
   * then a notice to `previousEmail`, off the response path. The new address
   * is proven and the step-up token verified before this runs. Fails with the
   * cap's message when two changes are already on record or the account no
   * longer holds `previousEmail`, and with a refusal when another account
   * holds the new address.
   */
  const commitEmailChange = (
    accountId: string,
    previousEmail: string,
    newEmail: string,
    currentSessionHash: string,
    nowSec: number,
    windowStart: number,
    changeId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ email: string }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // The cap holds at the commit as well as at the preflight: two
      // different requests — one claimed, then a second begun and completed —
      // each pass a preflight that counted one change. Every statement below
      // re-counts the changes in the window inside itself, and SQLite runs
      // each statement atomically, so once two are on record no statement
      // writes, whether or not D1 keeps one batch apart from another.
      const recentChanges = sql`(${db
        .select({ n: countFn() })
        .from(emailChanges)
        .where(
          and(eq(emailChanges.accountId, accountId), gte(emailChanges.completedAt, windowStart)),
        )})`;
      const ownChangeRecorded = exists(
        db
          .select({ one: sql`1` })
          .from(emailChanges)
          .where(eq(emailChanges.id, changeId)),
      );
      // Every session but the caller's device, which stays through a refresh
      // of its own session in flight (`outsideFamilyOf`). A hash no live
      // session holds spares nothing.
      const otherSessions = and(
        eq(sessions.accountId, accountId),
        outsideFamilyOf(db, sessions.familyId, currentSessionHash),
      );
      // The swap moves only the address the preflight read, which is the one
      // `previous_email` records and the notice goes to. A change that
      // committed after that read has moved it, so this swap moves nothing
      // and the request is refused with the cap's error, as below.
      const swap = db
        .update(accounts)
        .set({ email: newEmail, updatedAt: new Date(nowSec * 1000) })
        .where(
          and(
            eq(accounts.id, accountId),
            eq(accounts.email, previousEmail),
            lt(recentChanges, EMAIL_CHANGE_LIMIT),
          ),
        );
      // Records the change only while the account holds the address this
      // request wrote. Where two requests' statements interleave (bun:sqlite
      // runs them one at a time; D1 might), only the one whose address landed
      // last finds it here, so the change on record is the address that
      // stands. The other is refused with the cap's error even when it found
      // fewer than two changes, since the one that stands records next.
      const record = db.insert(emailChanges).select(
        db
          .select({
            id: bound(changeId, emailChanges.id),
            accountId: bound(accountId, emailChanges.accountId),
            previousEmail: bound(previousEmail, emailChanges.previousEmail),
            newEmail: bound(newEmail, emailChanges.newEmail),
            completedAt: bound(nowSec, emailChanges.completedAt),
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, accountId),
              eq(accounts.email, newEmail),
              lt(recentChanges, EMAIL_CHANGE_LIMIT),
            ),
          ),
      );
      // A refused request's sessions stay: the wipe runs only once its own
      // change is on record.
      const wipe = db.delete(sessions).where(and(otherSessions, ownChangeRecorded));
      // The security event is selected from this request's own change row, so
      // it is written exactly when that change is on record, as the wipe is.
      // Its id is the change's (`eventIdOf`), so it is written once per change.
      const event = db.insert(securityEvents).select(
        db
          .select({
            id: bound(eventIdOf(changeId), securityEvents.id),
            accountId: bound(accountId, securityEvents.accountId),
            kind: bound("email_changed" satisfies SecurityEventKind, securityEvents.kind),
            createdAt: bound(nowSec, securityEvents.createdAt),
            ipHash: bound(eventMeta?.ip ? hashIp(eventMeta.ip) : null, securityEvents.ipHash),
            uaLabel: bound(eventMeta?.uaLabel ?? null, securityEvents.uaLabel),
          })
          .from(emailChanges)
          .where(eq(emailChanges.id, changeId)),
      );
      // The notice goes to the address the preflight read, which the swap
      // above replaced, so it shares `previous_email`'s limit: where two
      // changes' statements interleave (bun:sqlite runs them one at a time) it
      // can name the other one's address. Forked with a timeout, so mailer
      // health never reaches the response.
      const notifyPrevious = forkBackground(
        securityEventsModule
          .notifySecurityEventTo(previousEmail, "email_changed", "email-changed", { newEmail })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.void),
          ),
      );
      // A commit can report a failure for a change that stands — D1 can fail
      // a batch it has committed, and bun:sqlite runs the statements one at a
      // time — so a failed commit still sends the notice when this request's
      // change is on record or the account holds the address it wrote. The
      // caller gets the failure either way, and a retry that then finds the
      // change on record answers it without a second notice.
      const notifyIfChanged = Effect.tryPromise(() =>
        db
          .select({ email: accounts.email, recorded: sql<number>`${ownChangeRecorded}` })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1),
      ).pipe(
        Effect.flatMap(([row]) =>
          row && (row.email === newEmail || Number(row.recorded) === 1)
            ? notifyPrevious
            : Effect.void,
        ),
        Effect.ignore,
      );

      const changed = yield* Effect.tryPromise({
        try: async () => {
          try {
            // One batch on D1, one statement at a time on bun:sqlite. The
            // swap goes first, so a UNIQUE(email) conflict throws before
            // anything is written on either driver. A refused request's swap
            // can land on bun:sqlite (or on D1, should it interleave batches)
            // and be overwritten by the swap that stands; its change and its
            // wipe never run. `previous_email` is the preflight's read, so
            // with two changes committing together it can name the address
            // before the other one.
            const [, recorded] = canBatch(db)
              ? await db.batch([swap, record, wipe, event])
              : ([await swap, await record, await wipe, await event] as const);
            if (rowsChanged(recorded) !== 1)
              return { ok: false as const, reason: "capped" as const };
            return { ok: true as const, email: newEmail };
          } catch (e) {
            const msg = driverErrorText(e);
            // Only a uniqueness violation is a genuine caller-facing conflict
            // (another account already claimed the address); see
            // `UNIQUE_CONSTRAINT_ERROR` for the full justification, shared
            // with `registration.ts`.
            if (UNIQUE_CONSTRAINT_ERROR.test(msg)) {
              return { ok: false as const, reason: "conflict" as const };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(Effect.tapError(() => notifyIfChanged));

      if (!changed.ok && changed.reason === "capped") {
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }
      if (!changed.ok) {
        // A UNIQUE(email) conflict: another account holds the address. Map to
        // a generic error that matches the begin-path enumeration posture.
        //
        // The claim has already spent the request, so a retry finds nothing
        // to complete: the address is held by another account, and a fresh
        // `begin` is the honest way back in should it ever come free.
        return yield* Effect.fail(
          new AuthError({ message: LINK_REFUSED, metricResult: "conflict" }),
        );
      }

      metricSessionSecurityInvalidation("email_change");
      metricSecurityEventRecorded("email_changed");
      yield* notifyPrevious;
      return { email: changed.email };
    });

  /**
   * The answer for a change already on record under `changeId`, writing its
   * `email_changed` event if an earlier try's commit failed before it. Sends
   * no notice: the try that committed the change sent it.
   */
  const recordedChange = (
    accountId: string,
    newEmail: string,
    changeId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ email: string }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const eventId = eventIdOf(changeId);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(securityEvents).select(
            db
              .select({
                id: bound(eventId, securityEvents.id),
                accountId: bound(accountId, securityEvents.accountId),
                kind: bound("email_changed" satisfies SecurityEventKind, securityEvents.kind),
                createdAt: emailChanges.completedAt,
                ipHash: bound(eventMeta?.ip ? hashIp(eventMeta.ip) : null, securityEvents.ipHash),
                uaLabel: bound(eventMeta?.uaLabel ?? null, securityEvents.uaLabel),
              })
              .from(emailChanges)
              .where(
                and(
                  eq(emailChanges.id, changeId),
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(securityEvents)
                      .where(eq(securityEvents.id, eventId)),
                  ),
                ),
              ),
          ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return { email: newEmail };
    });

  /** Whether the change `changeId` of `accountId` is on record. */
  const changeRecorded = (
    accountId: string,
    changeId: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: emailChanges.id })
            .from(emailChanges)
            .where(and(eq(emailChanges.id, changeId), eq(emailChanges.accountId, accountId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows.length > 0;
    });

  /**
   * `POST /account/email/:requestId/complete` — finishes an email change for
   * the tab that began, signed in as the account that began. Requires:
   *   - the request confirmed (its link opened at the new address and the
   *     right number picked), and still the account's pending change;
   *   - a step-up token for `email_change` (a passkey, or a link to the
   *     CURRENT address), checked only once the request is known to be
   *     completable, so a stale request spends no token;
   *   - fewer than 2 completed changes in the last 7 days, counted at the
   *     preflight and again inside every statement of the commit.
   *
   * The claim fixes the id the change is recorded under. Of two completes at
   * once one claims the request; the other is refused. The answer goes out
   * only once this call has spent the request, so of all the calls that ever
   * hold it exactly one answers the change. A refusal (the cap, a taken
   * address) spends it too; any other failure keeps the claim and lets go of
   * it, so a retry takes over at once and, finding the change already on
   * record under the claimed id, answers it rather than committing it twice.
   * The account's pending change is removed after the answer, once the
   * request is spent, and only while it still names this request, so a
   * begin since keeps its own.
   *
   * `currentSessionHash` is the caller's live session, which the route's
   * live-session gate resolved: the change revokes every session but that
   * one's device.
   */
  const completeEmailChange = (
    accountId: string,
    profileId: string,
    requestId: string,
    claimSecret: string,
    stepUpToken: string,
    currentSessionHash: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<
    { email: string },
    AuthError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const polled = yield* links.poll("email_change", requestId, claimSecret, accountId);
      if (polled.state !== "confirmed") {
        return yield* Effect.fail(new AuthError({ message: LINK_REFUSED }));
      }
      const entry = polled.entry;
      const pending = yield* storeCall(stores.pendingEmailChanges, "get", () =>
        stores.pendingEmailChanges.get(accountId),
      );
      if (
        !pending ||
        pending.requestId !== requestId ||
        entry.bound !== addressDigest(pending.newEmail)
      ) {
        return yield* Effect.fail(new AuthError({ message: LINK_REFUSED }));
      }

      // Purpose-bound: a token minted for another ceremony cannot be replayed
      // here. The verifier also applies the post-recovery cooldown — email
      // change is the pivot to a permanent, mailbox-independent takeover.
      yield* verifyStepUpForEmailChange(accountId, stepUpToken);

      const claimed = yield* links.claim(requestId, entry, {
        accountId,
        profileId,
        eventId: genId("ech_"),
      });
      if (!claimed) {
        return yield* Effect.fail(new AuthError({ message: LINK_REFUSED }));
      }
      // The request is spent or refused for good: free the account's pending
      // change after the answer, unless a begin since has replaced it.
      const dropPending = Effect.gen(function* () {
        yield* forkBackground(
          storeCall(stores.pendingEmailChanges, "delete", () =>
            stores.pendingEmailChanges.delete(accountId, pending),
          ).pipe(Effect.ignore),
        );
      });

      const done = yield* Effect.gen(function* () {
        const changeId = claimed.claim.eventId;
        if (claimed.claim.accountId !== accountId || changeId === undefined) {
          return yield* Effect.fail(new AuthError({ message: LINK_REFUSED }));
        }
        // An earlier try that committed this change and never answered it
        // left its record: answer it rather than commit it twice. That try
        // sent the notice when it saw the change stand; its event may have
        // failed after the change, so it is written here if it is missing.
        const result = (yield* changeRecorded(accountId, changeId))
          ? yield* recordedChange(accountId, pending.newEmail, changeId, eventMeta)
          : yield* finishChange(
              accountId,
              pending.newEmail,
              currentSessionHash,
              changeId,
              eventMeta,
            );
        // Another call took the request over and answers it.
        if (!(yield* links.spend(requestId, claimed))) return null;
        return result;
      }).pipe(
        Effect.tapError((e) =>
          e._tag === "AuthError"
            ? links.spend(requestId, claimed).pipe(Effect.ignore, Effect.andThen(dropPending))
            : links.letGo(requestId, claimed).pipe(Effect.ignore),
        ),
      );
      if (done === null) {
        return yield* Effect.fail(new AuthError({ message: LINK_REFUSED }));
      }
      yield* dropPending;
      return done;
    }).pipe(withEmailChange("complete"));

  /**
   * The preflight, then the commit: the account must still exist and hold
   * fewer than two changes in the window. Read outside the commit so the
   * write holds the writer lock briefly.
   */
  const finishChange = (
    accountId: string,
    newEmail: string,
    currentSessionHash: string,
    changeId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ email: string }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const windowStart = nowSec - EMAIL_CHANGE_WINDOW_SECONDS;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ email: accounts.email })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const current = rows[0];
      if (!current) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      if ((yield* changesSince(accountId, windowStart)) >= EMAIL_CHANGE_LIMIT) {
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }
      return yield* commitEmailChange(
        accountId,
        current.email,
        newEmail,
        currentSessionHash,
        nowSec,
        windowStart,
        changeId,
        eventMeta,
      );
    });

  return {
    beginEmailChange,
    emailChangeStatus,
    resendEmailChange,
    completeEmailChange,
  };
}
