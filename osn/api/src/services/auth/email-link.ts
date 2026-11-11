/**
 * The emailed-link challenge: proof that someone holds a mailbox, shared by
 * every flow that emails a link (sign-up and email recovery today).
 *
 * A flow opens a request and gets back a request id, a link secret, a claim
 * secret and a pairing number. Each secret is 256 random bits, stored only as
 * its SHA-256 hash; the pairing number is stored only as a keyed digest.
 *
 * - The email carries `<frontend origin>/verify/<request id>#<link secret>`.
 *   The secret rides in the fragment, which no browser sends to any server, so
 *   it reaches no log and no referrer.
 * - The tab that began shows the pairing number, and the confirm step
 *   requires it. Each flow has a pairing mode (`EMAIL_LINK_PAIRING_MODE`). In
 *   `pick` (sign-up) the page reads five candidates with the link secret and
 *   the reader picks one; in `type` (recovery) the reader types the number,
 *   and the candidates read answers as it does for an unknown request. The
 *   confirm `POST` carries the secret and the number; a wrong one ends the
 *   request at once. The reader can instead say they did not
 *   ask (`none`), which ends it too, and is answered `declined`, again on a
 *   repeat. Nothing here answers a `GET`, since mail scanners open every link
 *   before a person does.
 * - A confirm marks the request confirmed and does nothing else: it never
 *   mints a session, and no answer names the address or which candidate is
 *   right.
 * - The tab that began holds the claim secret and polls with it; once the
 *   request is confirmed, the poll claims it and the flow finishes. The
 *   device that opened the link and the device that gets the result can
 *   differ.
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
 * secrets are counted against `MAX_OTP_ATTEMPTS` on the request itself; the
 * guess that reaches it wipes the request and frees the flow's pending entry.
 * A wrong secret counts nowhere else: whoever began a request holds its id,
 * and a 256-bit secret needs no wider count. A wrong pick, which only the
 * holder of a link can make, also counts against the flow's subject
 * (`strikesOf`): sign-up's address, or recovery's account, which refuses a
 * right pick while it is locked (`admits`).
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
import { metricRecoveryLockout, withEmailLinkConfirm } from "../../metrics";
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
import { recordRecoveryLinkEvent } from "./recovery-link-event";
import { isProbeKey } from "./server-mac";
import { storeCall } from "./store-call";
import type { EmailLinkChallenge, EmailLinkClaim, EmailLinkFlow, PendingSignUp } from "./stores";
import type { SessionMeta } from "./types";

/** The request-id prefix of each flow. The confirm page reads the flow off it. */
export const EMAIL_LINK_ID_PREFIX = {
  registration: "signup_",
  recovery: "recovery_",
} as const satisfies Record<EmailLinkFlow, string>;

const idPattern = (prefixes: readonly string[]) =>
  `^(?:${prefixes.map((p) => p.slice(0, -1)).join("|")})_[a-f0-9]{12}$`;

/** A request id of any flow, as a route parameter pattern. */
export const EMAIL_LINK_ID_PATTERN = idPattern(Object.values(EMAIL_LINK_ID_PREFIX));

/** A request id of one flow, as a route parameter pattern. */
export const emailLinkIdPattern = (flow: EmailLinkFlow): string =>
  idPattern([EMAIL_LINK_ID_PREFIX[flow]]);

/** A link or claim secret: 32 bytes, hex. */
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
} as const satisfies Record<EmailLinkFlow, EmailLinkPairingMode>;

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
]);

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
  const { recoveryOtpLockoutStore } = ctx;
  const links = stores.emailLinks;

  /**
   * Each flow's own pending store, whose entries name the request they belong
   * to; null for a flow that keeps no pending state beside the request.
   * Recovery keeps none: its requests stand alone, so a stranger's begin for
   * an account neither replaces nor blocks the owner's.
   */
  const pendingStoreOf = (
    flow: EmailLinkFlow,
  ): CeremonyStore<{ readonly requestId: string }> | null => {
    switch (flow) {
      case "registration":
        return stores.pendingRegistrations;
      case "recovery":
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
            recordRecoveryLinkEvent(hashIp, subject, "recovery_otp_lockout", sessionMeta),
          );
        }
      });

  /**
   * Each flow's counter of wrong picks, and the key it counts under for a
   * request's subject. Sign-up counts per address exactly as typed,
   * lowercased, under the probe key its send reads; recovery per account (the
   * subject is the account id).
   */
  const strikesOf = (flow: EmailLinkFlow, subject: string): StrikeCounter => {
    switch (flow) {
      case "registration":
        return {
          store: registrationLinkLockoutStore,
          key: serverMac.probeKey(subject.toLowerCase()),
        };
      case "recovery":
        return {
          store: recoveryOtpLockoutStore,
          key: subject,
          counted: recoveryCounted(subject),
        };
    }
  };

  /** Counts one wrong pick against `entry`'s subject. */
  const strike = (entry: EmailLinkChallenge, sessionMeta?: SessionMeta) =>
    Effect.gen(function* () {
      const strikes = strikesOf(entry.flow, entry.subject);
      const count = yield* Effect.promise(() => strikes.store.recordFailure(strikes.key));
      if (strikes.counted) yield* strikes.counted(count, sessionMeta);
    });

  /**
   * After a first decline of `entry`, what its flow records. Recovery writes a
   * `recovery_link_declined` row for the account, after the answer, so the
   * owner's other devices show that someone asked to get in. Sign-up records
   * nothing: no account exists yet.
   */
  const declined = (entry: EmailLinkChallenge, sessionMeta?: SessionMeta) =>
    entry.flow === "recovery" && !isProbeKey(entry.subject)
      ? forkBackground(
          recordRecoveryLinkEvent(hashIp, entry.subject, "recovery_link_declined", sessionMeta),
        )
      : Effect.void;

  /**
   * Whether `entry`'s flow lets a right pick confirm it now. Recovery reads the
   * account's lockout: `locked` refuses; a count that cannot be read fails
   * with a `CoordinationError` (fail closed, and the request is kept, so the
   * page offers Try again). Sign-up reads nothing.
   */
  const admits = (entry: EmailLinkChallenge): Effect.Effect<boolean, CoordinationError> =>
    Effect.gen(function* () {
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
   * a missing request all read as null.
   */
  const held = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<EmailLinkChallenge | null, CoordinationError> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return null;
      const entry = yield* read(requestId);
      if (!usable(entry)) return null;
      const claimMatches = timingSafeEqualString(entry.claimSecretHash, sha256(claimSecret));
      if (!claimMatches || entry.flow !== flow) return null;
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
   * Ends `entry` (request `requestId`) and frees its flow's pending entry. A
   * delete that lost to a write since — a confirm, a Resend — re-reads and
   * deletes whatever entry still holds the request; a delete the store failed
   * is tried once more. The caller's answer does not wait on either: it is
   * `expired` whatever this manages, and a request whose delete failed twice
   * is left to expire, its pending entry freed all the same. A claimed
   * request, read first or on the re-read, is left as it is, its pending
   * entry with it: the poll that holds it finishes it.
   *
   * Answers whether this call ended the request: true when one of its deletes
   * removed the entry, or when the store did not answer the last one tried;
   * false when another write had already removed it, or it is claimed.
   */
  const end = (requestId: string, entry: EmailLinkChallenge) =>
    Effect.gen(function* () {
      let current: EmailLinkChallenge | null = entry;
      let ended = false;
      for (let attempt = 0; attempt < 2 && current; attempt++) {
        if (current.status === "claimed") return false;
        const from: EmailLinkChallenge = current;
        const removed = yield* storeCall(links, "consume", () =>
          links.consume(requestId, from),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        ended = removed !== false;
        if (removed === true) break;
        if (removed === false) {
          current = yield* read(requestId).pipe(Effect.catch(() => Effect.succeed(null)));
        }
      }
      yield* release(entry.flow, entry.subject, requestId).pipe(Effect.ignore);
      return ended;
    });

  /**
   * Opens a request of `flow` about `subject`. One store write, whatever the
   * flow does next, so every branch of a flow's begin can make the same call.
   * A registration request carries `signUp`, the sign-up it parks at
   * `subject`, so it can park later if it cannot now; a recovery request is
   * bound to `bound` (see `EmailLinkChallenge.bound`).
   */
  const open = (
    flow: EmailLinkFlow,
    subject: string,
    ttlMs: number,
    extra: { readonly signUp?: PendingSignUp; readonly bound?: string } = {},
  ): Effect.Effect<OpenedEmailLink, CoordinationError> =>
    Effect.gen(function* () {
      const requestId = genId(EMAIL_LINK_ID_PREFIX[flow]);
      const claimSecret = newSecret();
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
        pairingHash: serverMac.pairingDigest(requestId, pairingCode),
        status: "pending",
        expiresAt,
      };
      if (extra.signUp) entry.signUp = extra.signUp;
      if (extra.bound !== undefined) entry.bound = extra.bound;
      yield* storeCall(links, "set", () => links.set(requestId, entry, ttlMs));
      return {
        requestId,
        claimSecret,
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
   * counted as a wrong confirm is, and the one that reaches the cap wipes the
   * request (never a claimed one). A confirmed or claimed request answers
   * `confirmed` and offers no list, so a page reloaded after its confirm cannot
   * be made to pick again; a declined one is over, and answers `expired`. A
   * `type` flow's request has no list to offer: it answers `expired` after the
   * same one read an unknown request makes, and counts nothing.
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
        if (entry.status === "declined") return { status: "expired" } as const;
        return { status: "ready", pairingCandidates: candidatesOf(requestId) } as const;
      }
      const guessed = yield* guessEntry(links, requestId, MAX_OTP_ATTEMPTS);
      if (guessed?.standing === "last") yield* end(requestId, guessed.entry);
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
   * Ends request `requestId` because the holder of its link did not ask for
   * it. The entry is marked `declined` rather than deleted, so a repeat of the
   * decline is answered the same way; nothing can confirm, claim or resend it
   * after. The flow's pending entry is freed at once. A write that lost to
   * another (a Resend, a confirm) is tried once more on what the store now
   * holds. Every value read, the one after the last lost write included, is
   * checked alike: a request claimed or gone meanwhile (finished, wiped) is
   * refused, and one another decline ended reads as a repeat.
   */
  const decline = (requestId: string, entry: EmailLinkChallenge) =>
    Effect.gen(function* () {
      let current: EmailLinkChallenge | null = entry;
      for (let attempt = 0; ; attempt++) {
        if (!usable(current) || current.status === "claimed") return REFUSED;
        if (current.status === "declined") return REPEAT_DECLINE;
        if (attempt === 2) break;
        const from: EmailLinkChallenge = current;
        const won = yield* storeCall(links, "swap", () =>
          links.swap(requestId, from, { ...from, status: "declined" }, remainingMs(from)),
        );
        if (won) {
          yield* release(from.flow, from.subject, requestId).pipe(Effect.ignore);
          return DECLINED;
        }
        current = yield* read(requestId);
      }
      // Two writes lost to a request still pending or confirmed: end it
      // outright, which a decline asks for.
      yield* end(requestId, current);
      return DECLINED;
    });

  /**
   * Confirms request `requestId` for the holder of its link who picked the
   * waiting screen's number. Answers `confirmed` — again for a request already
   * confirmed or claimed, so a confirm whose answer was lost reads as done when
   * retried — and `expired` for every refusal. A wrong pick ends the request
   * at once, on a confirmed request too, and counts a strike against the
   * flow's subject when it is the call that ended the request.
   * A decline (`none`) ends it too, counts nothing, and answers `declined`,
   * again when repeated. A claimed request is past both: a wrong pick and a
   * decline on it are refused, and end nothing. `sessionMeta` is the
   * caller's, for a row a wrong pick or a decline may write.
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
      if (!guessed || guessed.standing === "spent" || !usable(guessed.entry)) return REFUSED;
      const { entry, standing } = guessed;
      if (!holdsLink(entry, input.linkSecret)) {
        if (standing !== "last") return REFUSED;
        return (yield* end(requestId, entry)) ? WIPED : REFUSED;
      }
      const declining = input.pairingPick === EMAIL_LINK_DECLINE;
      // A declined request is over: its decline can be repeated, nothing else.
      if (entry.status === "declined") return declining ? REPEAT_DECLINE : REFUSED;
      // A decline is the reader refusing a request they did not start: it
      // ends the request and counts nothing against them.
      if (declining) {
        const answered = yield* decline(requestId, entry);
        if (answered === DECLINED) yield* declined(entry, sessionMeta);
        return answered;
      }
      if (!picksRight(requestId, entry, input.pairingPick)) {
        // The strike counts only for the pick that ended the request: of two
        // wrong picks at once one counts, and a pick that lost the request to
        // the tab's claim counts nothing.
        if (yield* end(requestId, entry)) yield* strike(entry, sessionMeta);
        return WRONG_PICK;
      }
      if (entry.status === "confirmed" || entry.status === "claimed") return REPEAT;
      if (!(yield* admits(entry))) {
        yield* end(requestId, entry);
        return LOCKED;
      }

      // Two tries: a Resend can append a link to the entry between the read
      // and the write, which loses the first swap without changing the answer.
      // A decline that won meanwhile has ended the request: nothing confirms it.
      let current: EmailLinkChallenge | null = entry;
      for (let attempt = 0; attempt < 2 && usable(current); attempt++) {
        if (current.status === "declined") return REFUSED;
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
   * shows it again without having kept it anywhere.
   */
  const poll = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<EmailLinkPoll, CoordinationError> =>
    Effect.gen(function* () {
      const entry = yield* held(flow, requestId, claimSecret);
      if (!entry || entry.status === "declined") return { state: "expired" } as const;
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
   * poll, or in any other state. It keeps the request's own expiry.
   */
  const claim = (
    requestId: string,
    entry: EmailLinkChallenge,
    ids: Pick<EmailLinkClaim, "accountId" | "profileId" | "eventId">,
  ): Effect.Effect<ClaimedEmailLink | null, CoordinationError> =>
    Effect.gen(function* () {
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
   * One more link for the request, for the tab that holds its claim secret.
   * Every link sent stays usable, up to `EMAIL_LINK_MAX_SENDS` in all; the
   * request's expiry and pairing number do not change.
   */
  const resend = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<EmailLinkResend, CoordinationError> =>
    Effect.gen(function* () {
      let current = yield* held(flow, requestId, claimSecret);
      // Two tries: a confirm or another Resend can land between the read and
      // the write.
      for (let attempt = 0; attempt < 2 && current; attempt++) {
        if (current.status === "confirmed" || current.status === "claimed") {
          return { state: "confirmed" } as const;
        }
        if (current.status === "declined") return { state: "expired" } as const;
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
            url: linkUrl(requestId, linkSecret),
            expiresAt: from.expiresAt,
          } as const;
        }
        current = yield* held(flow, requestId, claimSecret);
      }
      return { state: "expired" } as const;
    });

  /**
   * Ends the request for the tab that holds its claim secret, and frees the
   * flow's pending entry for it. Answers whether it ended the request; without
   * a match, or for a claimed request, it answers false and touches nothing.
   */
  const retire = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<boolean, CoordinationError> =>
    Effect.gen(function* () {
      const entry = yield* held(flow, requestId, claimSecret);
      if (!entry) return false;
      return yield* end(requestId, entry);
    });

  return { open, markVerified, candidates, confirm, poll, claim, letGo, spend, resend, retire };
}

export type EmailLinkModule = ReturnType<typeof createEmailLinkModule>;
