/**
 * The emailed-link challenge: proof that someone holds a mailbox, shared by
 * every flow that emails a link (sign-up today).
 *
 * A flow opens a request and gets back a request id, a link secret, a claim
 * secret and a pairing number. Each secret is 256 random bits, stored only as
 * its SHA-256 hash; the pairing number is stored only as a keyed digest.
 *
 * - The email carries `<frontend origin>/verify/<request id>#<link secret>`.
 *   The secret rides in the fragment, which no browser sends to any server, so
 *   it reaches no log and no referrer.
 * - The tab that began shows the pairing number. The page the link opens
 *   reads a list of candidates with the link secret, and confirms with a
 *   `POST` that carries the secret and the number the reader picked. The
 *   confirm step requires the number shown on the waiting screen: a wrong
 *   pick ends the request at once. The reader can instead say they did not
 *   ask (`none`), which ends it too, and is answered `declined`, again on a
 *   repeat. Nothing here answers a `GET`, since mail scanners open every link
 *   before a person does.
 * - A confirm marks the request confirmed and does nothing else: it never
 *   mints a session, and no answer names the address or which candidate is
 *   right.
 * - The tab that began holds the claim secret and polls with it; once the
 *   request is confirmed, the flow claims it there and finishes. The device
 *   that opened the link and the device that gets the result can differ.
 *
 * Every refusal answers alike: an unknown request, a wrong secret, a spent or
 * expired one, and another flow's request all read as `expired`. Wrong link
 * secrets are counted against `MAX_OTP_ATTEMPTS` on the request itself; the
 * guess that reaches it wipes the request and frees the flow's pending entry.
 *
 * The request id starts with a prefix per flow (`EMAIL_LINK_ID_PREFIX`), so
 * the page can say what confirming does without reading anything.
 */

import { createHash } from "node:crypto";

import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import type { EmailLinkConfirmOutcome } from "@shared/observability/metrics";
import { Effect } from "effect";

import type { CeremonyStore } from "../../lib/ceremony-store";
import type { RecoveryLockoutStore } from "../../lib/recovery-lockout-store";
import { withEmailLinkConfirm } from "../../metrics";
import { claimEntry, guessEntry } from "./attempts";
import { EMAIL_LINK_MAX_SENDS, EMAIL_LINK_PAIRING_CANDIDATES, MAX_OTP_ATTEMPTS } from "./constants";
import type { AuthContext } from "./context";
import type { CoordinationError } from "./errors";
import { frontendOrigin, genId } from "./helpers";
import { storeCall } from "./store-call";
import type { EmailLinkChallenge, EmailLinkFlow, PendingSignUp } from "./stores";

/** The request-id prefix of each flow. The confirm page reads the flow off it. */
export const EMAIL_LINK_ID_PREFIX = {
  registration: "signup_",
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

/** A pick: a two-digit candidate, or `none` for "I didn't ask for this". */
export const EMAIL_LINK_PICK_PATTERN = "^(?:[0-9]{2}|none)$";

/** The pick that says the reader did not ask for the request. */
export const EMAIL_LINK_DECLINE = "none";

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
}

/** What the confirm page learns from its read. */
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
  | { readonly state: "confirmed"; readonly entry: EmailLinkChallenge };

/** What a Resend may do. */
export type EmailLinkResend =
  | {
      readonly state: "sent";
      readonly subject: string;
      /** The sign-up the request parks at `subject`; registration only. */
      readonly signUp?: PendingSignUp;
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

/** Where a flow counts a wrong pick: its store, and the key for one subject. */
interface StrikeCounter {
  readonly store: RecoveryLockoutStore;
  readonly key: string;
}

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
  const { config, stores, serverMac, registrationLinkLockoutStore } = ctx;
  const links = stores.emailLinks;

  /** Each flow's own pending store; its entries name the request they belong to. */
  const pendingStoreOf = (flow: EmailLinkFlow): CeremonyStore<{ readonly requestId: string }> => {
    switch (flow) {
      case "registration":
        return stores.pendingRegistrations;
    }
  };

  /**
   * Each flow's counter of wrong picks, and the key it counts under for a
   * request's subject. Sign-up counts per address exactly as typed,
   * lowercased, under the probe key its send reads.
   */
  const strikesOf = (flow: EmailLinkFlow, subject: string): StrikeCounter => {
    switch (flow) {
      case "registration":
        return {
          store: registrationLinkLockoutStore,
          key: serverMac.probeKey(subject.toLowerCase()),
        };
    }
  };

  const linkUrl = (requestId: string, linkSecret: string): string =>
    `${frontendOrigin(config)}/verify/${requestId}#${linkSecret}`;

  const candidatesOf = (requestId: string): string[] =>
    serverMac.pairingCandidates(requestId, EMAIL_LINK_PAIRING_CANDIDATES);

  /** What is left of `entry`'s life, for a write that must not extend it. */
  const remainingMs = (entry: EmailLinkChallenge): number =>
    Math.max(1, entry.expiresAt - Date.now());

  /** An entry this module wrote, live: any other shape or a past expiry is refused. */
  const usable = (entry: EmailLinkChallenge | null): entry is EmailLinkChallenge =>
    entry !== null &&
    entry.v === 1 &&
    typeof entry.pairingHash === "string" &&
    entry.pairingHash.length > 0 &&
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
   * is left to expire.
   *
   * Answers whether this call ended the request: true when one of its deletes
   * removed the entry, or when the store did not answer the last one tried;
   * false when another write had already removed it.
   */
  const end = (requestId: string, entry: EmailLinkChallenge) =>
    Effect.gen(function* () {
      let current: EmailLinkChallenge | null = entry;
      let ended = false;
      for (let attempt = 0; attempt < 2 && current; attempt++) {
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
   * Opens a request of `flow` whose pending state sits at `subject`. One store
   * write, whatever the flow does next, so every branch of a flow's begin can
   * make the same call. A registration request carries `signUp`, the sign-up
   * it parks at `subject`, so it can park later if it cannot now.
   */
  const open = (
    flow: EmailLinkFlow,
    subject: string,
    ttlMs: number,
    signUp?: PendingSignUp,
  ): Effect.Effect<OpenedEmailLink, CoordinationError> =>
    Effect.gen(function* () {
      const requestId = genId(EMAIL_LINK_ID_PREFIX[flow]);
      const claimSecret = newSecret();
      const linkSecret = newSecret();
      const candidates = candidatesOf(requestId);
      const pairingCode = candidates[randomIndex(candidates.length)]!;
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
      if (signUp) entry.signUp = signUp;
      yield* storeCall(links, "set", () => links.set(requestId, entry, ttlMs));
      return {
        requestId,
        claimSecret,
        pairingCode,
        url: linkUrl(requestId, linkSecret),
        expiresAt,
      };
    });

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
  const picksRight = (requestId: string, entry: EmailLinkChallenge, pairingPick: string) =>
    pairingPick !== EMAIL_LINK_DECLINE &&
    timingSafeEqualString(entry.pairingHash, serverMac.pairingDigest(requestId, pairingPick));

  /**
   * The request's number, recovered from its stored digest. Every candidate is
   * compared, so the work is the same whichever matches.
   */
  const pairingOf = (requestId: string, entry: EmailLinkChallenge): string | undefined => {
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
   * request. A confirmed request answers `confirmed` and offers no list, so a
   * page reloaded after its confirm cannot be made to pick again; a declined
   * one is over, and answers `expired`.
   */
  const candidates = (
    requestId: string,
    linkSecret: string,
  ): Effect.Effect<EmailLinkCandidates, CoordinationError> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return { status: "expired" } as const;
      const entry = yield* read(requestId);
      if (!usable(entry)) return { status: "expired" } as const;
      if (holdsLink(entry, linkSecret)) {
        if (entry.status === "confirmed") return { status: "confirmed" } as const;
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
  const REPEAT: Confirmed = { answer: "confirmed", outcome: "repeat" };
  const CONFIRMED: Confirmed = { answer: "confirmed", outcome: "confirmed" };

  /**
   * Ends request `requestId` because the holder of its link did not ask for
   * it. The entry is marked `declined` rather than deleted, so a repeat of the
   * decline is answered the same way; nothing can confirm, claim or resend it
   * after. The flow's pending entry is freed at once. A write that lost to
   * another (a Resend, a confirm) is tried once more on what the store now
   * holds; a request gone meanwhile (claimed, wiped) is refused.
   */
  const decline = (requestId: string, entry: EmailLinkChallenge) =>
    Effect.gen(function* () {
      let current: EmailLinkChallenge | null = entry;
      for (let attempt = 0; attempt < 2 && usable(current); attempt++) {
        if (current.status === "declined") return REPEAT_DECLINE;
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
      if (!usable(current)) return REFUSED;
      // Two writes lost: end the request outright, which a decline asks for.
      yield* end(requestId, current);
      return DECLINED;
    });

  /**
   * Confirms request `requestId` for the holder of its link who picked the
   * waiting screen's number. Answers `confirmed` — again for a request already
   * confirmed, so a confirm whose answer was lost reads as done when retried —
   * and `expired` for every refusal. A wrong pick ends the request at once, on
   * a confirmed request too, and counts a strike against the flow's subject
   * when it is the call that ended the request.
   * A decline (`none`) ends it too, counts nothing, and answers `declined`,
   * again when repeated.
   */
  const confirm = (
    requestId: string,
    input: EmailLinkConfirmInput,
  ): Effect.Effect<EmailLinkConfirmAnswer, CoordinationError> =>
    Effect.gen(function* () {
      if (!ANY_ID.test(requestId)) return REFUSED;
      // Read and counted in one call, before the secret is compared.
      const guessed = yield* guessEntry(links, requestId, MAX_OTP_ATTEMPTS);
      if (!guessed || guessed.standing === "spent" || !usable(guessed.entry)) return REFUSED;
      const { entry, standing } = guessed;
      if (!holdsLink(entry, input.linkSecret)) {
        if (standing !== "last") return REFUSED;
        yield* end(requestId, entry);
        return WIPED;
      }
      const declining = input.pairingPick === EMAIL_LINK_DECLINE;
      // A declined request is over: its decline can be repeated, nothing else.
      if (entry.status === "declined") return declining ? REPEAT_DECLINE : REFUSED;
      // A decline is the reader refusing a request they did not start: it
      // ends the request and counts nothing against them.
      if (declining) return yield* decline(requestId, entry);
      if (!picksRight(requestId, entry, input.pairingPick)) {
        // The strike counts only for the pick that ended the request: of two
        // wrong picks at once one counts, and a pick that lost the request to
        // the tab's claim counts nothing.
        if (yield* end(requestId, entry)) {
          const strikes = strikesOf(entry.flow, entry.subject);
          yield* Effect.promise(() => strikes.store.recordFailure(strikes.key));
        }
        return WRONG_PICK;
      }
      if (entry.status === "confirmed") return REPEAT;

      // Two tries: a Resend can append a link to the entry between the read
      // and the write, which loses the first swap without changing the answer.
      // A decline that won meanwhile has ended the request: nothing confirms it.
      let current: EmailLinkChallenge | null = entry;
      for (let attempt = 0; attempt < 2 && usable(current); attempt++) {
        if (current.status === "declined") return REFUSED;
        if (current.status === "confirmed") return REPEAT;
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
      if (entry.status === "confirmed") return { state: "confirmed", entry } as const;
      return { state: "pending", pairingCode: pairingOf(requestId, entry) } as const;
    });

  /**
   * Takes the confirmed `entry` for the one caller that finishes the flow:
   * true for exactly one caller, and only while `entry` is still the live one.
   */
  const claim = (requestId: string, entry: EmailLinkChallenge) =>
    claimEntry(links, requestId, entry);

  /**
   * Puts back a claimed `entry` whose flow could not finish for a reason that
   * may pass (a database fault), so the next poll can try again. It keeps the
   * request's own expiry.
   */
  const unclaim = (requestId: string, entry: EmailLinkChallenge) =>
    storeCall(links, "swap", () => links.swap(requestId, null, entry, remainingMs(entry)));

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
        if (current.status === "confirmed") return { state: "confirmed" } as const;
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
   * flow's pending entry for it. False, and nothing touched, without a match.
   */
  const retire = (
    flow: EmailLinkFlow,
    requestId: string,
    claimSecret: string,
  ): Effect.Effect<boolean, CoordinationError> =>
    Effect.gen(function* () {
      const entry = yield* held(flow, requestId, claimSecret);
      if (!entry) return false;
      yield* end(requestId, entry);
      return true;
    });

  return { open, candidates, confirm, poll, claim, unclaim, resend, retire };
}

export type EmailLinkModule = ReturnType<typeof createEmailLinkModule>;
