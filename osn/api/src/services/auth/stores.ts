/**
 * Ceremony / pending-state store contracts and their in-memory defaults.
 * Value shapes live here alongside the store bundle so the auth service and
 * the coordination bundle (`lib/coordination`) import them from one place.
 */

import {
  CEREMONY_STORE_MAX,
  createInMemoryCeremonyStore,
  type CeremonyStore,
  type CeremonyStoreOp,
} from "../../lib/ceremony-store";
import type { CeremonyStoreName } from "../../lib/coordination/names";
import { metricCeremonyStoreOp } from "../../metrics";
import type { PasskeyProvenance } from "./types";

/**
 * Minimal per-account cap surface — structurally compatible with
 * `RateLimiterBackend` from `@shared/rate-limit` and the coordination-store
 * limiter, so either passes straight in.
 */
export interface AccountCapLimiter {
  check(key: string): Promise<boolean>;
}

/**
 * The full set of ceremony / pending-state stores threaded through the
 * auth service. Bundled so the coordination bundle supplies all of them in one
 * place, and so tests can override the whole set at once.
 */
export interface CeremonyStores {
  registrationChallenges: CeremonyStore<RegistrationChallengeEntry>;
  loginChallenges: CeremonyStore<ChallengeEntry>;
  pendingRegistrations: CeremonyStore<PendingRegistration>;
  stepUpPasskeyChallenges: CeremonyStore<ChallengeEntry>;
  pendingTotpEnrollments: CeremonyStore<PendingTotpEnrollment>;
  pendingEmailChanges: CeremonyStore<PendingEmailChange>;
  crossDeviceRequests: CeremonyStore<CrossDeviceRequest>;
  authorizeRequests: CeremonyStore<PendingAuthorizeRequest>;
  recoveryDisownTokens: CeremonyStore<RecoveryDisownToken>;
  emailLinks: CeremonyStore<EmailLinkChallenge>;
}

// ---------------------------------------------------------------------------
// In-memory stores (module-level, single-process)
// ---------------------------------------------------------------------------

export interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
}

/**
 * A passkey registration challenge, plus what the credential it produces will
 * be stamped with.
 *
 * The provenance is decided at `begin` — that is where the step-up token is
 * verified and where the recovery-session bypass is granted — and the row is
 * written at `complete`, so it has to travel. This entry is that journey.
 *
 * Keyed by accountId like every other ceremony entry, so a second `begin`
 * replaces the first: a `complete` can only ever succeed against the challenge
 * its own `begin` parked, and the provenance parked with it cannot be swapped
 * by another caller.
 *
 * `provenanceAmr` and `recoveryEnrolment` are both required, but an entry parked
 * by a deploy older than either field arrives without it. `complete` reads each
 * through the most restrictive default rather than failing a ceremony the user
 * is halfway through — `recovery` for the provenance, `false` for the flag.
 */
export interface RegistrationChallengeEntry extends ChallengeEntry {
  provenanceAmr: PasskeyProvenance;
  /**
   * Whether `begin` granted the restricted-recovery-session bypass, and so
   * whether `complete` exempts this ceremony from `MAX_PASSKEYS_PER_ACCOUNT`
   * and runs the reclaim in its place.
   *
   * A separate field rather than `provenanceAmr === "recovery"`, because that
   * value is NOT unique to the bypass: `verifyStepUpForPasskeyRegister` also
   * returns it for a `webauthn` step-up carrying no provenance claim and for an
   * AMR its map does not name. Reading the exemption off the provenance would
   * hand it to an ordinary step-up enrolment, which is the one thing the cap has
   * to keep refusing.
   */
  recoveryEnrolment: boolean;
}

/**
 * The single-use "this wasn't me" token carried by the recovery notice email,
 * keyed by its public lookup id.
 *
 * Only the SHA-256 of the secret half is stored, and it is compared in constant
 * time — the same shape as {@link CrossDeviceRequest}'s `secretHash`, for the
 * same reason: the plaintext exists in the user's inbox and nowhere on the
 * server.
 *
 * `recoveredAt` is what makes the revocation precise. It names the instant the
 * disowned recovery happened, so the route can revoke exactly the credentials
 * that recovery produced rather than everything, or a fixed guess.
 */
export interface RecoveryDisownToken {
  /** SHA-256 of the secret half; the plaintext never reaches the server twice. */
  secretHash: string;
  accountId: string;
  /** Unix seconds of the recovery this token disowns. */
  recoveredAt: number;
  /** Milliseconds. */
  expiresAt: number;
}

/**
 * A sign-up waiting for its emailed link, keyed by the normalised address (or,
 * for a taken address, its probe key). One live entry per key: a second begin
 * for the address finds it and parks nothing, so it cannot replace the request
 * someone else's link belongs to. That request parks here on a Resend once the
 * key is empty.
 *
 * `requestId` names the {@link EmailLinkChallenge} this entry belongs to. Only
 * that request's claim creates the account, and only that request's wipe or
 * retirement removes the entry.
 */
export interface PendingRegistration {
  /** Empty for the decoy parked for a taken address: nothing is ever sent to it. */
  email: string;
  handle: string;
  displayName: string | null;
  requestId: string;
  expiresAt: number;
}

/**
 * The sign-up a registration request parks at its address: the pending entry
 * without the request it names and its expiry. A taken address's decoy holds
 * an empty email and handle.
 */
export type PendingSignUp = Omit<PendingRegistration, "requestId" | "expiresAt">;

/** The flows that prove an address with an emailed link. */
export type EmailLinkFlow = "registration" | "recovery" | "step_up" | "email_change";

/**
 * One emailed-link request, keyed by its request id. The link carries the
 * request id in its path and the link secret in its fragment; the tab that
 * began holds the claim secret and shows the pairing number. Only SHA-256
 * hashes of the two secrets are stored, and only a keyed digest of the pairing
 * number; the candidates the confirm page shows are derived from the request
 * id, never stored.
 *
 * `v` names the record's shape; an entry of any other shape is refused.
 */
export interface EmailLinkChallenge {
  v: 1;
  flow: EmailLinkFlow;
  /**
   * What the request is about, never returned by any route. Registration: the
   * key of its pending entry, the address or its probe key. Recovery: the
   * account id, or the typed address's probe key when it names no account.
   * Step-up and email change: the account id of the caller who began, which
   * every later call must be signed in as.
   */
  subject: string;
  /**
   * Registration only, on every registration request: the sign-up to park at
   * `subject`. A request whose begin found the address held parks it from
   * here, on a Resend, once the address is free. No birthdate.
   */
  signUp?: PendingSignUp;
  /**
   * A keyed digest the flow's claim checks again before it finishes, when the
   * flow sets one: the address the link went to (`serverMac.probeKey`).
   * Recovery and step-up check the account still has it, so a request begun
   * before the account's email changed cannot be claimed after; email change
   * checks its pending entry still names it.
   */
  bound?: string;
  /**
   * Step-up only: the `StepUpPurpose` the token its claim mints will name,
   * fixed when the request begins. The tab that polls never names one.
   */
  purpose?: string;
  /** The hash of every link sent for the request, newest last. */
  mailSecretHashes: string[];
  claimSecretHash: string;
  /** `serverMac.pairingDigest(requestId, pairing number)`. */
  pairingHash: string;
  /**
   * `confirmed` once a right link secret and pick were posted; the tab's poll
   * claims it from there. `claimed` once that poll has taken it to finish the
   * flow: `claim` says with what, and the entry stays until a poll has
   * delivered the result, so a finish that failed part way is finished by the
   * next poll. Nothing but the poll that finishes it ends a claimed request.
   * `declined` once the holder of a link said they did not ask, and `ended`
   * once they picked or typed a wrong number, or a right one the account's
   * lockout refused: the request is over, and the entry stays until it
   * expires, so a repeated decline gets the same answer and a quiet flow's tab
   * is answered as for a request never mailed (`EMAIL_LINK_QUIET`).
   */
  status: "pending" | "confirmed" | "claimed" | "declined" | "ended";
  /** Set exactly when `status` is `claimed`. */
  claim?: EmailLinkClaim;
  /** Milliseconds. */
  expiresAt: number;
}

/**
 * What a claimed request's flow finishes with, chosen once, when the claim is
 * made, so every try writes the same rows and a try after a fault finds what
 * an earlier one committed.
 */
export interface EmailLinkClaim {
  /** The account the flow creates or signs in to. */
  accountId: string;
  /** The profile the session is for. */
  profileId: string;
  /**
   * Recovery only: the id of the `account_recovered` row its finish writes.
   * A try after a fault that finds this row knows the recovery it would
   * refuse as a second one is its own, committed by an earlier try.
   */
  eventId?: string;
  /**
   * Milliseconds. While it is ahead, one poll is finishing the request and
   * every other poll is refused. A poll whose finish failed sets it to 0, so
   * the next poll takes over at once.
   */
  heldUntil: number;
}

// In-memory bounds (pending registrations, pending CDL, login challenges)
// are now enforced inside the ceremony store (CEREMONY_STORE_MAX) rather than
// per-call-site, so the old MAX_* constants are gone.

export interface CrossDeviceRequest {
  requestId: string;
  /** SHA-256 of the 256-bit secret — the plaintext never touches the server. */
  secretHash: string;
  status: "pending" | "approved" | "rejected";
  /** Device B's coarse UA label. */
  uaLabel: string | null;
  /** Device B's peppered IP hash. */
  ipHash: string | null;
  expiresAt: number; // milliseconds
  createdAt: number; // milliseconds
  /**
   * Set on approve: who approved, the profile device B signs in as, and the id
   * (a SHA-256 hash) of the `sessions` row reserved for device B. Never a
   * token: the reserved row's token was never kept, and the poll that takes
   * the approved entry replaces that row with the session it mints.
   */
  accountId?: string;
  profileId?: string;
  sessionId?: string;
}

// Challenge / pending-state value shapes. The stores that hold them are
// instantiated per-service (in-memory default or the injected coordination store) inside
// createAuthService — see CeremonyStores.

/**
 * A TOTP secret generated by `/totp/enroll/begin` and not yet confirmed —
 * keyed by accountId. It never reaches the database: an unconfirmed secret is not a
 * credential, and a ten-minute ceremony window is no reason to write one to
 * the durable store.
 *
 * Encrypted with the same key and helper as the stored credential, even for
 * these ten minutes. The store emits per-namespace telemetry and serialises
 * its value, and "the secret never reaches a log line" is much easier to hold
 * when the value is opaque everywhere.
 *
 * The fields are base64 strings rather than byte arrays because the in-memory
 * store keeps the value by reference while the Durable Object store round-trips
 * it through `JSON.stringify` — a `Uint8Array` here works in every test and
 * comes back from the store as `{"0":12,"1":200,…}`.
 */
export interface PendingTotpEnrollment {
  ciphertextB64: string;
  ivB64: string;
  keyVersion: number;
  expiresAt: number;
}

/**
 * An email change waiting for its new address's link, keyed by account id.
 * One per account: a new begin replaces it. `requestId` names the
 * {@link EmailLinkChallenge} it belongs to, so only that request's complete
 * moves the account to `newEmail`, and only that request's end removes it.
 */
export interface PendingEmailChange {
  /** The new address, lowercased. */
  newEmail: string;
  requestId: string;
  /** Milliseconds. */
  expiresAt: number;
}

/**
 * A `/authorize` request that passed validation but still needs the user —
 * to sign in, to pick a profile, or to approve the relying party.
 *
 * The whole request is parked SERVER-side and the browser is redirected to
 * the consent UI carrying nothing but an opaque id. The UI therefore cannot
 * alter the scope, the redirect URI, or the client it is asking about: the
 * parameters the user approves are, by construction, the parameters that were
 * validated. Nothing here is secret, but everything here is load-bearing.
 */
export interface PendingAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
  /**
   * The relying party's `max_age` in seconds, or null when absent. Re-checked
   * at decision time: the user can sit on the consent screen long enough for a
   * session that satisfied `max_age` at `/authorize` to stop satisfying it.
   */
  maxAge: number | null;
  /**
   * Unix seconds. When set, the deciding session must have been CREATED at or
   * after this instant — i.e. the user re-authenticated after the request was
   * parked. Set when `prompt=login` was demanded or `max_age` was already
   * exceeded at `/authorize`. Null when any live session may decide.
   */
  requireAuthAfter: number | null;
  /**
   * SHA-256 hex of the browser-binding secret handed out as a short-TTL
   * HttpOnly cookie alongside the interaction redirect. The decision (and
   * context read) must present the matching cookie, so a leaked or guessed
   * request id is useless in any other browser. Required: every parked
   * request carries one — a writer that omits it cannot silently disable the
   * binding check.
   */
  bindingHash: string;
  /** Milliseconds. */
  expiresAt: number;
}

// Consumed step-up token jtis (replay guard). Swept opportunistically.
const consumedStepUpTokens = new Map<string, number>();

/**
 * Single-flight guard interface for step-up token `jti` consumption.
 *
 * The default implementation (`createInMemoryJtiStore`) is a per-process
 * `Map` — correct for single-node dev and test, but breaks the "single-use"
 * advertised property across Worker isolates (a captured token could be
 * replayed once per isolate before any one of them has seen the jti).
 *
 * A deployed Worker passes the coordination store's (`createDurableJtiStore`
 * in `lib/coordination/durable.ts`), so the guard holds across every isolate.
 */
export interface StepUpJtiStore {
  /**
   * Returns `true` if the jti was consumed for the FIRST time (allow the
   * step-up verification to proceed). Returns `false` on replay (deny).
   * `ttlMs` must outlast every moment the token still verifies — its life
   * plus the verifier's clock tolerance past `exp` — so a replay inside that
   * tolerance still finds the claim.
   */
  consume(jti: string, ttlMs: number): Promise<boolean>;
}

/** Default in-memory jti store — single-process only. */
export function createInMemoryJtiStore(): StepUpJtiStore {
  return {
    async consume(jti, ttlMs) {
      const cutoff = Date.now() - ttlMs;
      for (const [k, ts] of consumedStepUpTokens) {
        if (ts < cutoff) consumedStepUpTokens.delete(k);
      }
      if (consumedStepUpTokens.has(jti)) return false;
      consumedStepUpTokens.set(jti, Date.now());
      return true;
    },
  };
}

/**
 * Single-use claims on discoverable passkey challenges, by nonce. The
 * challenge carries its own proof (see `server-mac.ts`), so nothing is stored
 * at `begin`; the first claim of a nonce is the one sign-in it allows.
 *
 * A deployed Worker passes the coordination store's
 * (`createDurableChallengeClaimStore`), so a challenge is used once across
 * every isolate; the in-memory default holds in one process only.
 */
export interface ChallengeClaimStore {
  /**
   * `passkey_challenge_claim` for discoverable passkey challenges;
   * `email_verification_nonce` for the nonces that bind a browser Email
   * Verification API token to the sign-up tab, so a token is accepted once.
   */
  readonly namespace: ChallengeClaimStoreName;
  /** True for the first claim of `nonce` within `ttlMs`; false for every later one. */
  claim(nonce: string, ttlMs: number): Promise<boolean>;
}

/** The coordination stores that hold single-use claims by nonce. */
export type ChallengeClaimStoreName = "passkey_challenge_claim" | "email_verification_nonce";

/** In-memory challenge claims — single-process only, bounded like the ceremony stores. */
export function createInMemoryChallengeClaimStore(
  namespace: ChallengeClaimStoreName = "passkey_challenge_claim",
): ChallengeClaimStore {
  const claimed = new Map<string, number>();
  return {
    namespace,
    async claim(nonce, ttlMs) {
      const nowMs = Date.now();
      if (claimed.size >= CEREMONY_STORE_MAX) {
        for (const [key, expiresAt] of claimed) {
          if (expiresAt <= nowMs) claimed.delete(key);
        }
      }
      const held = claimed.get(nonce);
      if (held !== undefined && held > nowMs) return false;
      claimed.set(nonce, nowMs + ttlMs);
      return true;
    },
  };
}

/**
 * Build the default in-memory ceremony stores. Each counts its operations on
 * the same metric as the Durable Object path, under `backend: "memory"`. Used
 * when `AuthConfig.ceremonyStores` is omitted.
 */
export function createDefaultCeremonyStores(): CeremonyStores {
  const observer = {
    onOp: (op: CeremonyStoreOp, namespace: CeremonyStoreName) =>
      metricCeremonyStoreOp({ op, namespace, backend: "memory" }),
  };
  return {
    registrationChallenges: createInMemoryCeremonyStore<RegistrationChallengeEntry>(
      "reg_challenge",
      observer,
    ),
    loginChallenges: createInMemoryCeremonyStore<ChallengeEntry>("login_challenge", observer),
    pendingRegistrations: createInMemoryCeremonyStore<PendingRegistration>(
      "pending_registration",
      observer,
    ),
    stepUpPasskeyChallenges: createInMemoryCeremonyStore<ChallengeEntry>(
      "step_up_challenge",
      observer,
    ),
    pendingTotpEnrollments: createInMemoryCeremonyStore<PendingTotpEnrollment>(
      "pending_totp_enroll",
      observer,
    ),
    pendingEmailChanges: createInMemoryCeremonyStore<PendingEmailChange>(
      "pending_email_change",
      observer,
    ),
    crossDeviceRequests: createInMemoryCeremonyStore<CrossDeviceRequest>("cross_device", observer),
    authorizeRequests: createInMemoryCeremonyStore<PendingAuthorizeRequest>(
      "oidc_authorize_request",
      observer,
    ),
    recoveryDisownTokens: createInMemoryCeremonyStore<RecoveryDisownToken>(
      "recovery_disown",
      observer,
    ),
    emailLinks: createInMemoryCeremonyStore<EmailLinkChallenge>("email_link", observer),
  };
}

/**
 * A default in-memory fixed-window per-account cap limiter. Structurally a
 * `RateLimiterBackend` so the same `check(key)` contract is satisfied by the
 * coordination-store limiter a deployed Worker injects.
 */
export function createInMemoryAccountCap(maxRequests: number, windowMs: number): AccountCapLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async check(key: string): Promise<boolean> {
      const nowMs = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || nowMs >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return true;
      }
      if (bucket.count >= maxRequests) return false;
      bucket.count += 1;
      return true;
    },
  };
}
