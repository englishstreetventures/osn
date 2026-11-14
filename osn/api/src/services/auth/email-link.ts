/**
 * The emailed-link challenge: proof that someone holds a mailbox, shared by
 * every flow that emails a link: sign-up, email recovery, step-up and email
 * change.
 *
 * A flow opens a request and gets back a request id, a link secret, a claim
 * secret, a retire secret and a pairing number. Each secret is 256 random
 * bits, stored only as its SHA-256 hash; the pairing number is stored only as
 * a keyed digest.
 *
 * - The email carries `<frontend origin>/verify/<request id>#<link secret>`.
 *   The secret rides in the fragment, which no browser sends to any server, so
 *   it reaches no log and no referrer.
 * - The tab that began shows the pairing number, and the confirm step
 *   requires it. Each flow has a pairing mode (`EMAIL_LINK_PAIRING_MODE`). In
 *   `pick` (sign-up, email change) the page reads five candidates with the
 *   link secret and the reader picks one; in `type` (recovery, step-up, whose
 *   links go to an account's own address at someone else's asking) the reader
 *   types the number,
 *   and the candidates read answers as it does for an unknown request. The
 *   confirm `POST` carries the secret and the number; a wrong one ends the
 *   request at once (`ended`). The reader can instead say they did not ask
 *   (`none`), which ends it too (`declined`), and is answered `declined`,
 *   again on a repeat. Nothing here answers a `GET`, since mail scanners open
 *   every link before a person does.
 * - An ended or declined request stays until its expiry. In a quiet flow
 *   (`EMAIL_LINK_QUIET`: sign-up, recovery and email change, whose links can
 *   go to an address nobody has proven to the tab that began) the tab's poll
 *   and Resend answer it exactly as a request whose link was never mailed:
 *   `pending` with the number, and `sent` with nothing mailed, until it
 *   expires. So whatever the link's reader does, the tab that began learns
 *   nothing a request for a taken or unknown address would not tell it.
 *   Step-up's link goes to the signed-in account's own address, and its tab
 *   reads `expired` at once.
 * - A confirm marks the request confirmed and does nothing else: it never
 *   mints a session, and no answer names the address or which candidate is
 *   right.
 * - The tab that began holds the claim secret and polls with it; once the
 *   request is confirmed, the poll claims it and the flow finishes. The
 *   device that opened the link and the device that gets the result can
 *   differ.
 * - The retire secret ends the request ({@link retire}) and does nothing
 *   else: no poll, Resend, candidates read, confirm or claim compares it, so
 *   it never yields the number, a link or the flow's result. Sign-up hands it
 *   out so another tab of the same browser can end a request it did not
 *   begin; no other flow hands it out.
 * - A claim records what the flow finishes with (the account and profile,
 *   and for recovery the id of the audit row it writes) and stays on the
 *   request until a poll has delivered the result, so a finish that failed
 *   part way is finished by the next poll, on the same rows. Nothing else
 *   ends a claimed request: a decline, a wrong pick, wrong secrets and a
 *   retire leave it as it is, and its finish does not need the flow's
 *   pending entry.
 *
 * Every refusal answers alike: an unknown request, a wrong secret, a spent or
 * expired one, and another flow's request all read as `expired`. Wrong link
 * secrets are counted against `MAX_OTP_ATTEMPTS` on the request itself, and
 * every guess past it is refused without the secret being compared. In a
 * loud flow the guess that reaches it also wipes the request and frees its
 * pending entry; in a quiet flow it ends nothing, since the count it reaches
 * would show whether the reader's own confirm, which counts as a guess and
 * whose write restarts the count, came first. Each wrong secret then costs
 * the one counting call whatever the count. A wrong secret counts nowhere
 * else: whoever began a request holds its id, and a 256-bit secret needs no
 * wider count. A wrong pick, which only the
 * holder of a link can make, also counts against the flow's subject
 * (`strikesOf`): sign-up's and email change's address, or recovery's and
 * step-up's account, which refuses a right number while it is locked
 * (`admits`).
 *
 * The request id starts with a prefix per flow (`EMAIL_LINK_ID_PREFIX`), so
 * the page can say what confirming does without reading anything.
 */

import { createHash } from "node:crypto";

import type { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import type { EmailLinkConfirmOutcome } from "@shared/observability/metrics";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import type { CeremonyStore } from "../../lib/ceremony-store";
import {
  RECOVERY_LOCKOUT_THRESHOLD,
  type RecoveryLockoutStore,
} from "../../lib/recovery-lockout-store";
import { metricRecoveryLockout, metricStepUpLockout, withEmailLinkConfirm } from "../../metrics";
import { claimEntry, guessEntry } from "./attempts";
import {
  EMAIL_LINK_CLAIM_HOLD_MS,
  EMAIL_LINK_MAX_SENDS,
  EMAIL_LINK_PAIRING_CANDIDATES,
  MAX_OTP_ATTEMPTS,
} from "./constants";
import type { AuthContext } from "./context";
import { CoordinationError } from "./errors";
import { frontendOrigin, genId } from "./helpers";
import { recordLinkEvent } from "./link-event";
import { isProbeKey } from "./server-mac";
import { storeCall } from "./store-call";
import type { EmailLinkChallenge, EmailLinkClaim, EmailLinkFlow, PendingSignUp } from "./stores";
import type { SessionMeta } from "./types";

/** The request-id prefix of each flow. The confirm page reads the flow off it. */
export const EMAIL_LINK_ID_PREFIX = {
  registration: "signup_",
  recovery: "recovery_",
  step_up: "stepup_",
  email_change: "emailchange_",
} as const satisfies Record<EmailLinkFlow, string>;

const idPattern = (prefixes: readonly string[]) =>
  `^(?:${prefixes.map((p) => p.slice(0, -1)).join("|")})_[a-f0-9]{12}$`;

/** A request id of any flow, as a route parameter pattern. */
export const EMAIL_LINK_ID_PATTERN = idPattern(Object.values(EMAIL_LINK_ID_PREFIX));

/** A request id of one flow, as a route parameter pattern. */
export const emailLinkIdPattern = (flow: EmailLinkFlow): string =>
  idPattern([EMAIL_LINK_ID_PREFIX[flow]]);

/** A link, claim or retire secret: 32 bytes, hex. */
export const EMAIL_LINK_SECRET_PATTERN = "^[a-f0-9]{64}$";

/**
 * How a flow's reader proves they can see the waiting screen: `pick` the
 * number among five candidates (a blind pick is right one time in five), or
 * `type` it (one time in a hundred: two digits, `00`–`99`).
 */
export type EmailLinkPairingMode = "pick" | "type";

export const EMAIL_LINK_PAIRING_MODE = {
  registration: "pick",
  recovery: "type",
  step_up: "type",
  email_change: "pick",
} as const satisfies Record<EmailLinkFlow, EmailLinkPairingMode>;

/**
 * Whether a flow answers the tab that began alike after its request ends at
 * the reader's hand (a decline, a wrong pick, a number the account's lockout
 * refused): `pending` to a poll and `sent` to a Resend, nothing mailed, until
 * the request expires, as for a request whose link was never mailed. A flow
 * whose link can go to an address the tab that began has not proven is quiet:
 * sign-up and email change (an address anyone can type), and recovery (an
 * address that may name no account). Step-up's link goes to the signed-in
 * account's own address, so its tab is told at once.
 */
export const EMAIL_LINK_QUIET = {
  registration: true,
  recovery: true,
  step_up: false,
  email_change: true,
} as const satisfies Record<EmailLinkFlow, boolean>;

/**
 * What a confirm's `pairingPick` may be, by mode: a two-digit candidate, or one
 * to six typed digits; `none` declines in either. Anything else is refused like
 * any other refusal, before any store call.
 */
const PICK_FORMAT = {
  pick: /^(?:[0-9]{2}|none)$/,
  type: /^(?:[0-9]{1,6}|none)$/,
} as const satisfies Record<EmailLinkPairingMode, RegExp>;

/** The pick that says the reader did not ask for the request. */
export const EMAIL_LINK_DECLINE = "none";

/** The flow a request id belongs to, read off its prefix; null for none. */
const flowOfId = (requestId: string): EmailLinkFlow | null => {
  for (const flow of Object.keys(EMAIL_LINK_ID_PREFIX) as EmailLinkFlow[]) {
    if (requestId.startsWith(EMAIL_LINK_ID_PREFIX[flow])) return flow;
  }
  return null;
};

/**
 * A typed number as the waiting screen writes it: `7`, `07` and `007` are
 * the same number, `07`. A typed value past `99` is left as typed, and is
 * never right.
 */
const typedAsShown = (typed: string): string => {
  const value = Number(typed);
  return value < 100 ? String(value).padStart(2, "0") : typed;
};

const ANY_ID = new RegExp(EMAIL_LINK_ID_PATTERN);

/** What a confirm sends: the link's secret and the number the reader picked. */
export interface EmailLinkConfirmInput {
  readonly linkSecret: string;
  /** A candidate, or {@link EMAIL_LINK_DECLINE}. */
  readonly pairingPick: string;
}

/** A request just opened: what the flow mails, and what it hands the tab that began. */
export interface OpenedEmailLink {
  readonly requestId: string;
  readonly claimSecret: string;
  /** Ends the request ({@link retire}) and can do nothing else. */
  readonly retireSecret: string;
  /** The number the tab that began shows, which the reader picks on the confirm page. */
  readonly pairingCode: string;
  /** The link to mail, secret included. */
  readonly url: string;
  /** Milliseconds. */
  readonly expiresAt: number;
  /** The entry as written, for a write that must name the value it replaces. */
  readonly entry: EmailLinkChallenge;
}

/**
 * What the confirm page learns from its read. `pairingCandidates` comes sorted
 * ascending; the waiting screen's number is equally likely to be at any place
 * in it, so hosts pass it on as given.
 */
export type EmailLinkCandidates =
  | { readonly status: "ready"; readonly pairingCandidates: string[] }
  | { readonly status: "confirmed" }
  | { readonly status: "expired" };

/** What a confirm answers: a number accepted, a decline accepted, or a refusal. */
export type EmailLinkConfirmAnswer = "confirmed" | "declined" | "expired";

/** What the tab that began learns from a poll. */
export type EmailLinkPoll =
  | {
      readonly state: "pending";
      /**
       * The number the waiting screen shows, so a tab that lost it (a reload)
       * can show it again. Absent only when the server's key changed since the
       * request began, and then no pick can confirm it either.
       */
      readonly pairingCode?: string;
    }
  | { readonly state: "expired" }
  /** Confirmed, or claimed by a poll; `claim` decides which poll may finish it. */
  | { readonly state: "confirmed"; readonly entry: EmailLinkChallenge };

/** A request one poll holds to finish: claimed, with what it finishes with. */
export type ClaimedEmailLink = EmailLinkChallenge & {
  readonly status: "claimed";
  readonly claim: EmailLinkClaim;
};

/** What a Resend may do. */
export type EmailLinkResend =
  | {
      readonly state: "sent";
      readonly subject: string;
      /** The sign-up the request parks at `subject`; registration only. */
      readonly signUp?: PendingSignUp;
      /** The request's `bound`, or undefined when its flow set none. */
      readonly bound: string | undefined;
      /** The request's `purpose`, or undefined when its flow set none. */
      readonly purpose: string | undefined;
      /**
       * True when the request has ended (a quiet flow's ended or declined
       * request): the caller mails nothing, and makes the calls it makes for a
       * request whose link it never mails.
       */
      readonly ended: boolean;
      readonly url: string;
      /** Milliseconds; the request's own expiry, unchanged by the Resend. */
      readonly expiresAt: number;
    }
  | { readonly state: "expired" }
  | { readonly state: "limit" }
  | { readonly state: "confirmed" };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const newSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
};

/** Where a flow counts wrong picks on a request's subject: its store, and the key for one subject. */
interface StrikeCounter {
  readonly store: RecoveryLockoutStore;
  readonly key: string;
  /**
   * Runs after each failure is counted, with the count, or `"unknown"` when
   * it could not be. Its own background work goes through `forkBackground`,
   * so the answer never waits on it.
   */
  readonly counted?: (
    count: number | "unknown",
    sessionMeta?: SessionMeta,
  ) => Effect.Effect<void, never, Db>;
}

const STATUSES: ReadonlySet<string> = new Set<EmailLinkChallenge["status"]>([
  "pending",
  "confirmed",
  "claimed",
  "declined",
  "ended",
]);

/** Whether a request has ended at the reader's hand, its entry kept until it expires. */
const isOver = (entry: EmailLinkChallenge): boolean =>
  entry.status === "declined" || entry.status === "ended";

/**
 * How many times a close tries its write. Only a Resend (at most
 * `EMAIL_LINK_MAX_SENDS - 1` of them) and the reader's own confirm can write
 * the entry between its read and its write, so a close that tries this often
 * always lands unless the store fails.
 */
const CLOSE_TRIES = EMAIL_LINK_MAX_SENDS + 1;

/**
 * How many unsettled requests one process holds before it sweeps out the
 * expired ones. A live one is never dropped: refusing it is the point.
 */
const UNSETTLED_SWEEP_AT = 1_000;

/** Whether `claim` is a whole claim record, as {@link EmailLinkClaim} describes. */
const isClaim = (claim: EmailLinkClaim | undefined): claim is EmailLinkClaim =>
  typeof claim === "object" &&
  claim !== null &&
  typeof claim.accountId === "string" &&
  claim.accountId.length > 0 &&
  typeof claim.profileId === "string" &&
  claim.profileId.length > 0 &&
  typeof claim.heldUntil === "number";

/** A uniform index below `n` (`n` ≤ 256), from `crypto.getRandomValues`. */
const randomIndex = (n: number): number => {
  const ceiling = Math.floor(256 / n) * n;
  const byte = new Uint8Array(1);
  do {
    crypto.getRandomValues(byte);
  } while (byte[0]! >= ceiling);
  return byte[0]! % n;
};

export function createEmailLinkModule(ctx: AuthContext) {
  const { config, stores, serverMac, hashIp, registrationLinkLockoutStore } = ctx;
  const { recoveryOtpLockoutStore, stepUpLinkLockoutStore } = ctx;
  const links = stores.emailLinks;

  /**
   * Each flow's own pending store, whose entries name the request they belong
   * to; null for a flow that keeps no pending state beside the request.
   * Recovery and step-up keep none: their requests stand alone, so a
   * stranger's begin for an account neither replaces nor blocks the owner's.
   * Email change keeps the new address beside its request, keyed by account.
   */
  const pendingStoreOf = (
    flow: EmailLinkFlow,
  ): CeremonyStore<{ readonly requestId: string }> | null => {
    switch (flow) {
      case "registration":
        return stores.pendingRegistrations;
      case "email_change":
        return stores.pendingEmailChanges;
      case "recovery":
      case "step_up":
        return null;
    }
  };

  /**
   * Recovery's account count, after each failure: the lockout metric, and
   * the audit row once the count reaches the threshold. A probe key names no
   * account, so it gets no row.
   */
  const recoveryCounted =
    (subject: string) =>
    (count: number | "unknown", sessionMeta?: SessionMeta): Effect.Effect<void, never, Db> =>
      Effect.gen(function* () {
        if (count === "unknown") {
          metricRecoveryLockout("unavailable");
          return;
        }
        if (count < RECOVERY_LOCKOUT_THRESHOLD) {
          metricRecoveryLockout("recorded");
          return;
        }
        metricRecoveryLockout("locked");
        if (count === RECOVERY_LOCKOUT_THRESHOLD && !isProbeKey(subject)) {
          yield* forkBackground(
            recordLinkEvent(hashIp, subject, "recovery_otp_lockout", sessionMeta),
          );
        }
      });

  /**
   * Step-up's account count, after each failure: the lockout metric, and the
   * audit row once the count reaches the threshold, after the answer. The
   * subject is always the signed-in account's id.
   */
  const stepUpCounted =
    (subject: string) =>
    (count: number | "unknown", sessionMeta?: SessionMeta): Effect.Effect<void, never, Db> =>
      Effect.gen(function* () {
        if (count === "unknown") {
          metricStepUpLockout("unavailable");
          return;
        }
        if (count < RECOVERY_LOCKOUT_THRESHOLD) {
          metricStepUpLockout("recorded");
          return;
        }
        metricStepUpLockout("locked");
        if (count === RECOVERY_LOCKOUT_THRESHOLD) {
          yield* forkBackground(
            recordLinkEvent(hashIp, subject, "step_up_link_lockout", sessionMeta),
          );
        }
      });

  /**
   * Each flow's counter of wrong numbers, and the key it counts `entry` under.
   * Sign-up and email change count per address exactly as typed, lowercased,
   * under the probe key their sends read, on the one counter for links to an
   * address not yet proven (email change's address is its `bound`); recovery
   * and step-up per account (the subject is the account id), each on a
   * counter of its own.
   */
  const strikesOf = (entry: EmailLinkChallenge): StrikeCounter => {
    switch (entry.flow) {
      case "registration":
        return {
          store: registrationLinkLockoutStore,
          key: serverMac.probeKey(entry.subject.toLowerCase()),
        };
      case "email_change":
        return {
          store: registrationLinkLockoutStore,
          key: entry.bound ?? serverMac.probeKey(entry.subject),
        };
      case "recovery":
        return {
          store: recoveryOtpLockoutStore,
          key: entry.subject,
          counted: recoveryCounted(entry.subject),
        };
      case "step_up":
        return {
          store: stepUpLinkLockoutStore,
          key: entry.subject,
          counted: stepUpCounted(entry.subject),
        };
    }
  };

  /** Counts one wrong pick against `entry`'s subject. */
  const strike = (entry: EmailLinkChallenge, sessionMeta?: SessionMeta) =>
    Effect.gen(function* () {
      const strikes = strikesOf(entry);
      const count = yield* Effect.promise(() => strikes.store.recordFailure(strikes.key));
      if (strikes.counted) yield* strikes.counted(count, sessionMeta);
    });

  /**
   * After a first decline of `entry`, what its flow records, after the
   * answer. Recovery writes a `recovery_link_declined` row for the account, so
   * the owner's other devices show that someone asked to get in; step-up
   * writes `step_up_link_declined`, since someone signed in to the account
   * asked to act and the owner said no. Sign-up and email change record
   * nothing: the next begin's first link counts against the mailbox's
   * first-link window as every first link does.
   */
  const declined = (entry: EmailLinkChallenge, sessionMeta?: SessionMeta) => {
    switch (entry.flow) {
      case "recovery":
        return isProbeKey(entry.subject)
          ? Effect.void
          : forkBackground(
              recordLinkEvent(hashIp, entry.subject, "recovery_link_declined", sessionMeta),
            );
      case "step_up":
        return forkBackground(
          recordLinkEvent(hashIp, entry.subject, "step_up_link_declined", sessionMeta),
        );
      case "registration":
      case "email_change":
        return Effect.void;
    }
  };

  /**
   * Whether `entry`'s flow lets a right number confirm it now. Recovery and
   * step-up read the account's lockout: `locked` refuses; a count that cannot
   * be read fails with a `CoordinationError` (fail closed, and the request is
   * kept, so the page offers Try again). Sign-up and email change read
   * nothing.
   */
  const admits = (entry: EmailLinkChallenge): Effect.Effect<boolean, CoordinationError> =>
    Effect.gen(function* () {
      if (entry.flow === "step_up") {
        const reading = yield* Effect.promise(() => stepUpLinkLockoutStore.status(entry.subject));
        if (reading.status === "open") return true;
        if (reading.status === "locked") {
          metricStepUpLockout("locked");
          return false;
        }
        metricStepUpLockout("unavailable");
        return yield* Effect.fail(
          new CoordinationError({ store: "step_up_link_lockout", op: "count" }),
        );
      }
      if (entry.flow !== "recovery") return true;
      const reading = yield* Effect.promise(() => recoveryOtpLockoutStore.status(entry.subject));
      if (reading.status === "open") return true;
      if (reading.status === "locked") {
        metricRecoveryLockout("locked");
        return false;
      }
      metricRecoveryLockout("unavailable");
      return yield* Effect.fail(
        new CoordinationError({ store: "recovery_otp_lockout", op: "count" }),
      );
    });

  const linkUrl = (requestId: string, linkSecret: string): string =>
    `${frontendOrigin(config)}/verify/${requestId}#${linkSecret}`;

  const candidatesOf = (requestId: string): string[] =>
    serverMac.pairingCandidates(requestId, EMAIL_LINK_PAIRING_CANDIDATES);

  /** A `pick` flow's number: one of its candidates, drawn at random. */
  const pickedPairing = (requestId: string): string => {
    const candidates = candidatesOf(requestId);
    return candidates[randomIndex(candidates.length)]!;
  };

  /** What is left of `entry`'s life, for a write that must not extend it. */
  const remainingMs = (entry: EmailLinkChallenge): number =>
    Math.max(1, entry.expiresAt - Date.now());

  /**
   * An entry this module wrote, live: any other shape — a status no write
   * gives, a claimed entry without its claim — or a past expiry is refused.
   */
  const usable = (entry: EmailLinkChallenge | null): entry is EmailLinkChallenge =>
    entry !== null &&
    entry.v === 1 &&
    typeof entry.pairingHash === "string" &&
    entry.pairingHash.length > 0 &&
    STATUSES.has(entry.status) &&
    (entry.status !== "claimed" || isClaim(entry.claim)) &&
    Date.now() <= entry.expiresAt;

  const read = (requestId: string) => storeCall(links, "get", () => links.get(requestId));

  /**
   * The live request `requestId` of `flow` whose claim secret is
   * `claimSecret`, or null. A wrong flow, a wrong claim secret, an expired or
   * a missing request all read as null; so does another `subject`'s, when the
   * caller names the subject it is signed in as.
   */
  const held = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
    subject?: string,
  ): Effect.Effect<EmailLinkChallenge | null, CoordinationError> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return null;
      const entry = yield* read(requestId);
      if (!usable(entry)) return null;
      const claimMatches = timingSafeEqualString(entry.claimSecretHash, sha256(claimSecret));
      if (!claimMatches || entry.flow !== flow) return null;
      if (subject !== undefined && entry.subject !== subject) return null;
      return entry;
    });

  /**
   * Remove `flow`'s pending entry at `subject` if it still belongs to
   * `requestId`, so the key can take a new request at once. It makes its
   * delete call either way — a no-op when the entry names another request —
   * so the answer costs the same whether or not someone else holds the key.
   */
  const release = (
    flow: EmailLinkFlow,
    subject: string,
    requestId: string,
  ): Effect.Effect<void, CoordinationError> =>
    Effect.gen(function* () {
      const pending = pendingStoreOf(flow);
      if (!pending) return;
      const value = yield* storeCall(pending, "get", () => pending.get(subject));
      // The expected value names this request, so the delete removes the
      // entry only when it is this request's.
      const expected = value?.requestId === requestId ? value : { ...value, requestId };
      yield* storeCall(pending, "delete", () => pending.delete(subject, expected));
    });

  /**
   * Deletes `entry` (request `requestId`) and frees its flow's pending entry:
   * the tab's own retire, a loud flow's wipe, and a close that could not
   * write its mark. A delete that lost to a write since — a confirm, a Resend
   * — re-reads and deletes whatever entry still holds the request; a delete
   * the store failed is tried once more. A claimed request, read first or on
   * the re-read, is left as it is, its pending entry with it: the poll that
   * holds it finishes it.
   *
   * Answers `removed` when one of its deletes removed the entry, `gone` when
   * another write had already removed it or it is claimed, and `unanswered`
   * when the store did not answer the last delete tried, so the entry may
   * still be there.
   */
  const removeEntry = (requestId: string, entry: EmailLinkChallenge) =>
    Effect.gen(function* () {
      let current: EmailLinkChallenge | null = entry;
      let outcome: "removed" | "gone" | "unanswered" = "gone";
      for (let attempt = 0; attempt < 2 && current; attempt++) {
        if (current.status === "claimed") return "gone" as const;
        const from: EmailLinkChallenge = current;
        const removed = yield* storeCall(links, "consume", () =>
          links.consume(requestId, from),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        if (removed === true) {
          outcome = "removed";
          break;
        }
        if (removed === null) {
          outcome = "unanswered";
          continue;
        }
        outcome = "gone";
        current = yield* read(requestId).pipe(Effect.catch(() => Effect.succeed(null)));
      }
      yield* release(entry.flow, entry.subject, requestId).pipe(Effect.ignore);
      return outcome;
    });

  /**
   * {@link removeEntry}, answering whether this call ended the request: true
   * when it removed the entry or the store did not answer, false when another
   * write had already removed it or it is claimed. The caller's answer is
   * `expired` whatever this manages.
   */
  const end = (requestId: string, entry: EmailLinkChallenge) =>
    removeEntry(requestId, entry).pipe(Effect.map((outcome) => outcome !== "gone"));

  /**
   * Requests whose ending this process could neither mark nor delete, by
   * request id, to their expiry (ms). A confirm and a claim here refuse them,
   * so a store fault never leaves a request confirmable after a wrong pick,
   * a decline or a refused number. Entries live at most a request's life.
   */
  const unsettled = new Map<string, number>();

  const holdUnsettled = (requestId: string, entry: EmailLinkChallenge): void => {
    const now = Date.now();
    if (unsettled.size >= UNSETTLED_SWEEP_AT) {
      for (const [id, until] of unsettled) if (until <= now) unsettled.delete(id);
    }
    unsettled.set(requestId, entry.expiresAt);
  };

  const isUnsettled = (requestId: string): boolean => {
    const until = unsettled.get(requestId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    unsettled.delete(requestId);
    return false;
  };

  /**
   * Opens a request of `flow` about `subject`. One store write, whatever the
   * flow does next, so every branch of a flow's begin can make the same call.
   * A registration request carries `signUp`, the sign-up it parks at
   * `subject`, so it can park later if it cannot now; a recovery, step-up or
   * email-change request is bound to `bound`, and a step-up request is for
   * `purpose` (see `EmailLinkChallenge`).
   */
  const open = (
    flow: EmailLinkFlow,
    subject: string,
    ttlMs: number,
    extra: {
      readonly signUp?: PendingSignUp;
      readonly bound?: string;
      readonly purpose?: string;
    } = {},
  ): Effect.Effect<OpenedEmailLink, CoordinationError> =>
    Effect.gen(function* () {
      const requestId = genId(EMAIL_LINK_ID_PREFIX[flow]);
      const claimSecret = newSecret();
      const retireSecret = newSecret();
      const linkSecret = newSecret();
      const pairingCode =
        EMAIL_LINK_PAIRING_MODE[flow] === "type"
          ? serverMac.typedPairing(requestId)
          : pickedPairing(requestId);
      const expiresAt = Date.now() + ttlMs;
      const entry: EmailLinkChallenge = {
        v: 1,
        flow,
        subject,
        mailSecretHashes: [sha256(linkSecret)],
        claimSecretHash: sha256(claimSecret),
        retireSecretHash: sha256(retireSecret),
        pairingHash: serverMac.pairingDigest(requestId, pairingCode),
        status: "pending",
        expiresAt,
      };
      if (extra.signUp) entry.signUp = extra.signUp;
      if (extra.bound !== undefined) entry.bound = extra.bound;
      if (extra.purpose !== undefined) entry.purpose = extra.purpose;
      yield* storeCall(links, "set", () => links.set(requestId, entry, ttlMs));
      return {
        requestId,
        claimSecret,
        retireSecret,
        pairingCode,
        url: linkUrl(requestId, linkSecret),
        expiresAt,
        entry,
      };
    });

  /**
   * One write on a request just opened, made by every begin whose browser
   * token verified: `confirm` true marks it confirmed, as a right pick on its
   * link would, so the tab's next poll finishes it with no mail; false writes
   * the same value back, so a taken or held address's begin makes the same
   * call as a free one's. One swap naming the value `open` wrote. Answers
   * whether the request is confirmed now; a lost swap (nothing else holds the
   * request's secrets yet) or a failed store leaves it pending, and the caller
   * mails its link as on any begin.
   */
  const markVerified = (
    opened: OpenedEmailLink,
    confirm: boolean,
  ): Effect.Effect<boolean, never> => {
    const from = opened.entry;
    const next: EmailLinkChallenge = confirm ? { ...from, status: "confirmed" } : from;
    return storeCall(links, "swap", () =>
      links.swap(opened.requestId, from, next, remainingMs(from)),
    ).pipe(
      Effect.map((won) => won && confirm),
      Effect.catch(() => Effect.succeed(false)),
    );
  };

  /**
   * Whether `linkSecret` is one of the request's links. Every hash is
   * compared, in constant time, so the answer takes as long whichever matched.
   */
  const holdsLink = (entry: EmailLinkChallenge, linkSecret: string): boolean => {
    const offered = sha256(linkSecret);
    let matched = false;
    for (const known of entry.mailSecretHashes) {
      if (timingSafeEqualString(known, offered)) matched = true;
    }
    return matched;
  };

  /** Whether `pairingPick` is the number the tab that began shows. A decline never is. */
  const picksRight = (requestId: string, entry: EmailLinkChallenge, pairingPick: string) => {
    if (pairingPick === EMAIL_LINK_DECLINE) return false;
    const offered =
      EMAIL_LINK_PAIRING_MODE[entry.flow] === "type" ? typedAsShown(pairingPick) : pairingPick;
    return timingSafeEqualString(entry.pairingHash, serverMac.pairingDigest(requestId, offered));
  };

  /**
   * The request's number, recovered from its stored digest. Every candidate is
   * compared, so the work is the same whichever matches.
   */
  const pairingOf = (requestId: string, entry: EmailLinkChallenge): string | undefined => {
    if (EMAIL_LINK_PAIRING_MODE[entry.flow] === "type") {
      const typed = serverMac.typedPairing(requestId);
      return timingSafeEqualString(entry.pairingHash, serverMac.pairingDigest(requestId, typed))
        ? typed
        : undefined;
    }
    let found: string | undefined;
    for (const candidate of candidatesOf(requestId)) {
      if (timingSafeEqualString(entry.pairingHash, serverMac.pairingDigest(requestId, candidate))) {
        found = candidate;
      }
    }
    return found;
  };

  /**
   * The candidates for the confirm page, for the holder of a link. A right
   * secret is answered from one read and counts nothing, so a reload, or a
   * scanner that runs the page's script, spends nothing. A wrong secret is
   * counted as a wrong confirm is, and in a loud flow the one that reaches the
   * cap wipes the request (never a claimed one). A confirmed or claimed
   * request answers `confirmed` and offers no list, so a page reloaded after
   * its confirm cannot be made to pick again; an ended or declined one is
   * over, and answers `expired`. A `type` flow's request has no list to
   * offer: it answers `expired` after the same one read an unknown request
   * makes, and counts nothing.
   */
  const candidates = (
    requestId: string,
    linkSecret: string,
  ): Effect.Effect<EmailLinkCandidates, CoordinationError> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return { status: "expired" } as const;
      const entry = yield* read(requestId);
      if (!usable(entry)) return { status: "expired" } as const;
      if (EMAIL_LINK_PAIRING_MODE[entry.flow] === "type") return { status: "expired" } as const;
      if (holdsLink(entry, linkSecret)) {
        if (entry.status === "confirmed" || entry.status === "claimed") {
          return { status: "confirmed" } as const;
        }
        if (isOver(entry)) return { status: "expired" } as const;
        return { status: "ready", pairingCandidates: candidatesOf(requestId) } as const;
      }
      const guessed = yield* guessEntry(links, requestId, MAX_OTP_ATTEMPTS);
      if (guessed?.standing === "last" && !EMAIL_LINK_QUIET[guessed.entry.flow]) {
        yield* end(requestId, guessed.entry);
      }
      return { status: "expired" } as const;
    }).pipe(Effect.withSpan("auth.email_link.candidates"));

  type Confirmed = { answer: EmailLinkConfirmAnswer; outcome: EmailLinkConfirmOutcome };
  const REFUSED: Confirmed = { answer: "expired", outcome: "refused" };
  const WIPED: Confirmed = { answer: "expired", outcome: "wiped" };
  const WRONG_PICK: Confirmed = { answer: "expired", outcome: "wrong_pick" };
  const DECLINED: Confirmed = { answer: "declined", outcome: "declined" };
  const REPEAT_DECLINE: Confirmed = { answer: "declined", outcome: "repeat" };
  const LOCKED: Confirmed = { answer: "expired", outcome: "refused" };
  const REPEAT: Confirmed = { answer: "confirmed", outcome: "repeat" };
  const CONFIRMED: Confirmed = { answer: "confirmed", outcome: "confirmed" };

  /**
   * How a close went: `closed`, this call ended the request; `repeat`, it was
   * already over in the same way; `refused`, it was claimed, gone, or over in
   * the other way; `lost`, every write lost to another and nothing is marked.
   */
  type Closed = { readonly by: "closed" | "repeat" | "refused" | "lost" };

  /**
   * Ends request `requestId` at the reader's hand, as `to`: `declined` when
   * they did not ask, `ended` for a wrong pick or a number the account's
   * lockout refused. The entry is kept, marked, until it expires, so a repeat
   * of the decline is answered the same way, a quiet flow's tab is answered as
   * for a request never mailed, and nothing can confirm, claim or resend it
   * after. The flow's pending entry is freed at once. A write that lost to
   * another (a Resend, a confirm) is tried again on what the store now holds,
   * up to `CLOSE_TRIES` times; every value read is checked alike: a request
   * claimed or gone meanwhile (finished, wiped) is refused, and one another
   * close ended reads as a repeat or a refusal. A store fault fails it; see
   * {@link endAs} for what then ends the request.
   */
  const close = (
    requestId: string,
    entry: EmailLinkChallenge,
    to: "declined" | "ended",
  ): Effect.Effect<Closed, CoordinationError> =>
    Effect.gen(function* () {
      let current: EmailLinkChallenge | null = entry;
      for (let attempt = 0; ; attempt++) {
        if (!usable(current) || current.status === "claimed") return { by: "refused" } as const;
        if (isOver(current)) return { by: current.status === to ? "repeat" : "refused" } as const;
        if (attempt === CLOSE_TRIES) break;
        const from: EmailLinkChallenge = current;
        const won = yield* storeCall(links, "swap", () =>
          links.swap(requestId, from, { ...from, status: to }, remainingMs(from)),
        );
        if (won) {
          yield* release(from.flow, from.subject, requestId).pipe(Effect.ignore);
          return { by: "closed" } as const;
        }
        current = yield* read(requestId);
      }
      return { by: "lost" } as const;
    });

  /**
   * Ends `entry` as `to`, and never leaves it confirmable: a request one
   * wrong pick, decline or refused number has ended gets no second guess.
   *
   *  1. The close ({@link close}); a store fault on it is tried once more.
   *     When the retry finds the mark already there, the first write landed
   *     and only its answer was lost: this call ended it.
   *  2. Should neither write its mark, the request is deleted instead. A quiet
   *     flow's tab then reads `expired` before the expiry, which it otherwise
   *     never would; that is the price of a store fault, never of a guess.
   *  3. Should the delete not be answered either, this process refuses the
   *     request (`unsettled`) at every later confirm and claim until it
   *     expires, and the caller answers a refusal.
   *
   * Answers `closed` when this call ended the request (marked or deleted),
   * `repeat` and `refused` as {@link close} does, and `unsettled` for step 3.
   */
  const endAs = (
    requestId: string,
    entry: EmailLinkChallenge,
    to: "declined" | "ended",
  ): Effect.Effect<"closed" | "repeat" | "refused" | "unsettled"> =>
    Effect.gen(function* () {
      let faulted = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const closed = yield* close(requestId, entry, to).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (closed === null) {
          faulted = true;
          continue;
        }
        if (closed.by === "repeat" && faulted) return "closed";
        if (closed.by !== "lost") return closed.by;
        break;
      }
      const removed = yield* removeEntry(requestId, entry);
      if (removed === "removed") return "closed";
      if (removed === "gone") return "refused";
      holdUnsettled(requestId, entry);
      return "unsettled";
    });

  /**
   * Confirms request `requestId` for the holder of its link who picked the
   * waiting screen's number. Answers `confirmed` — again for a request already
   * confirmed or claimed, so a confirm whose answer was lost reads as done when
   * retried — and `expired` for every refusal. A wrong pick ends the request
   * at once (`ended`), on a confirmed request too, and counts a strike against
   * the flow's subject when it is the call that ended the request.
   * A decline (`none`) ends it too (`declined`), counts nothing, and answers
   * `declined`, again when repeated. A claimed request is past both: a wrong
   * pick and a decline on it are refused, and end nothing. An ended request
   * refuses everything. `sessionMeta` is the caller's, for a row a wrong pick
   * or a decline may write.
   */
  const confirm = (
    requestId: string,
    input: EmailLinkConfirmInput,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<EmailLinkConfirmAnswer, CoordinationError, Db> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return REFUSED;
      const flow = flowOfId(requestId);
      if (!flow || !PICK_FORMAT[EMAIL_LINK_PAIRING_MODE[flow]].test(input.pairingPick)) {
        return REFUSED;
      }
      // Read and counted in one call, before the secret is compared.
      const guessed = yield* guessEntry(links, requestId, MAX_OTP_ATTEMPTS);
      if (!guessed || !usable(guessed.entry) || isUnsettled(requestId)) return REFUSED;
      const { entry, standing } = guessed;
      // Past the count nothing is compared, except a decline: it confirms
      // nothing and needs no guesses, and whoever began the request must not
      // be able to spend the count and so keep the link's reader from saying
      // they did not ask.
      if (standing === "spent") {
        const declining = input.pairingPick === EMAIL_LINK_DECLINE;
        if (!declining || !holdsLink(entry, input.linkSecret)) return REFUSED;
      }
      if (!holdsLink(entry, input.linkSecret)) {
        // A quiet flow ends nothing here: see the module's note on the count.
        if (standing !== "last" || EMAIL_LINK_QUIET[entry.flow]) return REFUSED;
        return (yield* end(requestId, entry)) ? WIPED : REFUSED;
      }
      const declining = input.pairingPick === EMAIL_LINK_DECLINE;
      // A declined request is over: its decline can be repeated, nothing else.
      if (entry.status === "declined") return declining ? REPEAT_DECLINE : REFUSED;
      // An ended one is over too, for everything.
      if (entry.status === "ended") return REFUSED;
      // A decline is the reader refusing a request they did not start: it
      // ends the request and counts nothing against them.
      if (declining) {
        const ending = yield* endAs(requestId, entry, "declined");
        if (ending === "repeat") return REPEAT_DECLINE;
        // Unsettled: the decline did not land, so it is not answered as one.
        if (ending !== "closed") return REFUSED;
        yield* declined(entry, sessionMeta);
        return DECLINED;
      }
      if (!picksRight(requestId, entry, input.pairingPick)) {
        // The strike counts only for the pick that ended the request, or tried
        // to and met a store fault: of two wrong picks at once one counts, and
        // a pick that lost the request to the tab's claim counts nothing.
        const ending = yield* endAs(requestId, entry, "ended");
        if (ending === "closed" || ending === "unsettled") yield* strike(entry, sessionMeta);
        return WRONG_PICK;
      }
      if (entry.status === "confirmed" || entry.status === "claimed") return REPEAT;
      if (!(yield* admits(entry))) {
        yield* endAs(requestId, entry, "ended");
        return LOCKED;
      }

      // Two tries: a Resend can append a link to the entry between the read
      // and the write, which loses the first swap without changing the answer.
      // A close that won meanwhile has ended the request: nothing confirms it.
      let current: EmailLinkChallenge | null = entry;
      for (let attempt = 0; attempt < 2 && usable(current); attempt++) {
        if (isOver(current)) return REFUSED;
        if (current.status === "confirmed" || current.status === "claimed") return REPEAT;
        const from: EmailLinkChallenge = current;
        const won = yield* storeCall(links, "swap", () =>
          links.swap(requestId, from, { ...from, status: "confirmed" }, remainingMs(from)),
        );
        if (won) return CONFIRMED;
        current = yield* read(requestId);
      }
      return REFUSED;
    }).pipe(
      withEmailLinkConfirm((result: Confirmed) => result.outcome),
      Effect.map((result) => result.answer),
    );

  /**
   * The tab that began asks where its request stands. One store read. A
   * pending answer carries the request's number, so a tab that was reloaded
   * shows it again without having kept it anywhere. An ended or declined
   * request reads as pending in a quiet flow, number included, until it
   * expires, and as expired in a loud one. A flow whose caller is signed in
   * names the `subject` it is signed in as; another subject's request reads as
   * expired.
   */
  const poll = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
    subject?: string,
  ): Effect.Effect<EmailLinkPoll, CoordinationError> =>
    Effect.gen(function* () {
      const entry = yield* held(flow, requestId, claimSecret, subject);
      if (!entry || (isOver(entry) && !EMAIL_LINK_QUIET[flow])) {
        return { state: "expired" } as const;
      }
      if (entry.status === "confirmed" || entry.status === "claimed") {
        return { state: "confirmed", entry } as const;
      }
      return { state: "pending", pairingCode: pairingOf(requestId, entry) } as const;
    });

  /**
   * Takes the request a poll read (`entry`) for that poll to finish, holding
   * it for `EMAIL_LINK_CLAIM_HOLD_MS`. A confirmed request is claimed with
   * `ids`, which every later try then uses; a claimed one whose hold has
   * passed, or was let go, is taken over with the ids it already holds. One
   * swap naming the whole value read, so of several polls at once exactly one
   * gets it. Null for every other poll, and for a request held by another
   * poll, in any other state, or one this process holds as unsettled. It keeps
   * the request's own expiry.
   */
  const claim = (
    requestId: string,
    entry: EmailLinkChallenge,
    ids: Pick<EmailLinkClaim, "accountId" | "profileId" | "eventId">,
  ): Effect.Effect<ClaimedEmailLink | null, CoordinationError> =>
    Effect.gen(function* () {
      if (isUnsettled(requestId)) return null;
      const now = Date.now();
      const heldUntil = now + EMAIL_LINK_CLAIM_HOLD_MS;
      let next: ClaimedEmailLink;
      if (entry.status === "confirmed") {
        next = { ...entry, status: "claimed", claim: { ...ids, heldUntil } };
      } else if (
        entry.status === "claimed" &&
        isClaim(entry.claim) &&
        entry.claim.heldUntil <= now
      ) {
        next = { ...entry, status: "claimed", claim: { ...entry.claim, heldUntil } };
      } else {
        return null;
      }
      const won = yield* storeCall(links, "swap", () =>
        links.swap(requestId, entry, next, remainingMs(entry)),
      );
      return won ? next : null;
    });

  /**
   * Lets go of a request this poll holds (`claimed`) but could not finish, so
   * the next poll takes it over at once rather than when the hold passes. The
   * claim and its ids stay. A no-op once anything else has written the entry.
   */
  const letGo = (requestId: string, claimed: ClaimedEmailLink) =>
    storeCall(links, "swap", () =>
      links.swap(
        requestId,
        claimed,
        { ...claimed, claim: { ...claimed.claim, heldUntil: 0 } },
        remainingMs(claimed),
      ),
    );

  /**
   * Ends a request this poll holds (`claimed`) once its flow is done with it:
   * delivered, or refused for good. True only while `claimed` is still the
   * live entry, so of all the polls that ever held the request, one delivers.
   */
  const spend = (requestId: string, claimed: ClaimedEmailLink) =>
    claimEntry(links, requestId, claimed);

  /**
   * One more link for the request, for the tab that holds its claim secret
   * (signed in as `subject`, where the flow names one). Every link sent stays
   * usable, up to `EMAIL_LINK_MAX_SENDS` in all; the request's expiry and
   * pairing number do not change. A quiet flow's ended or declined request is
   * answered as a live one, `limit` included, and its entry written as a live
   * one's is, with `ended` set so the caller mails nothing; a loud flow's
   * reads as expired.
   */
  const resend = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
    subject?: string,
  ): Effect.Effect<EmailLinkResend, CoordinationError> =>
    Effect.gen(function* () {
      let current = yield* held(flow, requestId, claimSecret, subject);
      // Two tries: a confirm or another Resend can land between the read and
      // the write.
      for (let attempt = 0; attempt < 2 && current; attempt++) {
        if (current.status === "confirmed" || current.status === "claimed") {
          return { state: "confirmed" } as const;
        }
        const over = isOver(current);
        if (over && !EMAIL_LINK_QUIET[flow]) return { state: "expired" } as const;
        if (current.mailSecretHashes.length >= EMAIL_LINK_MAX_SENDS) {
          return { state: "limit" } as const;
        }
        const from: EmailLinkChallenge = current;
        const linkSecret = newSecret();
        const next: EmailLinkChallenge = {
          ...from,
          mailSecretHashes: [...from.mailSecretHashes, sha256(linkSecret)],
        };
        const won = yield* storeCall(links, "swap", () =>
          links.swap(requestId, from, next, remainingMs(from)),
        );
        if (won) {
          return {
            state: "sent",
            subject: from.subject,
            signUp: from.signUp,
            bound: from.bound,
            purpose: from.purpose,
            ended: over,
            url: linkUrl(requestId, linkSecret),
            expiresAt: from.expiresAt,
          } as const;
        }
        current = yield* held(flow, requestId, claimSecret, subject);
      }
      return { state: "expired" } as const;
    });

  /**
   * Ends the request for the holder of its retire secret, and frees the
   * flow's pending entry for it. Answers whether it ended the request. A
   * wrong flow, an unknown, expired or malformed request, a request that
   * carries no retire digest and a wrong secret (the claim secret included)
   * each cost the one read and touch nothing, alike; so does a claimed
   * request, past the read, as {@link end} leaves it.
   */
  const retire = (
    flow: EmailLinkFlow,
    requestId: string,
    retireSecret: string,
  ): Effect.Effect<boolean, CoordinationError> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return false;
      const entry = yield* read(requestId);
      if (!usable(entry) || entry.flow !== flow) return false;
      // A request with no retire digest compares against nothing, and never
      // matches.
      const stored = typeof entry.retireSecretHash === "string" ? entry.retireSecretHash : "";
      if (!timingSafeEqualString(stored, sha256(retireSecret))) return false;
      return yield* end(requestId, entry);
    });

  return { open, markVerified, candidates, confirm, poll, claim, letGo, spend, resend, retire };
}

export type EmailLinkModule = ReturnType<typeof createEmailLinkModule>;
