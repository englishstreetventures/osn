/**
 * Step-up (sudo) client helpers.
 *
 * Step-up is a short-lived high-assurance ceremony required by sensitive
 * endpoints (recovery-code generation, email change). The client fetches
 * a step-up token via a passkey, a link emailed to the account's own address,
 * or an authenticator code, and attaches it — typically as `step_up_token` in
 * the request body — to the gated call.
 *
 * The WebAuthn browser ceremony (`startAuthentication`) is intentionally
 * left to the caller so `@osn/client` stays free of
 * `@simplewebauthn/browser` as a runtime dep.
 *
 * The step-up token travels in the gated call's body or `X-Step-Up-Token`,
 * never in `Authorization`, so `authFetch` neither renews nor replaces it.
 */

import { OsnApiError } from "./api-error";
import { reach, readJson } from "./auth-fetch";
import type { AuthFetch } from "./runtime";

export interface StepUpClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

export class StepUpError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = "StepUpError";
  }
}

export interface StepUpToken {
  token: string;
  /** Seconds until the step-up token expires. */
  expiresIn: number;
}

/**
 * Ceremony a step-up token is minted for. The server stamps it into the
 * token as a `purpose` claim, and gated endpoints that name a purpose
 * reject tokens minted for any other one — so a token taken from an
 * email-change flow cannot be replayed to burn recovery codes.
 *
 * Mirrors `StepUpPurpose` in `@shared/observability`; kept as a local
 * literal union so the browser SDK stays free of a server-side dep.
 */
export type StepUpPurpose =
  | "recovery_generate"
  | "passkey_register"
  | "passkey_delete"
  | "email_change"
  | "security_event_ack"
  | "account_delete"
  | "account_export"
  | "totp_enroll"
  | "totp_disable"
  | "pulse_app_delete"
  | "zap_app_delete";

/** A step-up by emailed link this tab began: what it keeps, and the number it shows. */
export interface StepUpEmailRequest {
  readonly requestId: string;
  /** Kept by this tab alone, in memory; whoever holds it receives the token. */
  readonly claimSecret: string;
  /** Shown while waiting: the link's page asks the reader to type it. Never stored or logged. */
  readonly pairingCode: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** What a step-up link's status poll learned: still waiting, gone, or the token. */
export type StepUpEmailStatus =
  | {
      readonly status: "pending";
      /** The number the waiting screen shows, for a tab that lost it. */
      readonly pairingCode?: string;
    }
  | { readonly status: "expired" }
  | { readonly status: "complete"; readonly token: StepUpToken };

/**
 * A rejection of `authFetch` about the session, or the caller's abort,
 * reaches the caller unchanged (`./auth-fetch.ts`); every other failure is
 * a `StepUpError`.
 */
export interface StepUpClient {
  /**
   * Fetch a WebAuthn assertion challenge scoped to the authenticated
   * account. The caller drives the browser ceremony with the returned
   * `options`, then calls `passkeyComplete`.
   *
   * Typed as the standard `PublicKeyCredentialRequestOptionsJSON` — the same
   * lib.dom shape `PasskeysClient.registerBegin` already returns for the
   * enrolment half of this flow — so callers get the real challenge shape
   * instead of having to assert their way out of `unknown`.
   */
  passkeyBegin(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
  }>;
  passkeyComplete(input: {
    assertion: unknown;
    /** Binds the minted token to one ceremony. Omit only for legacy gates. */
    purpose?: StepUpPurpose;
  }): Promise<StepUpToken>;
  /**
   * Mails a link to the account's own address for one `purpose`, which the
   * token it yields will name. The reader types the number this tab shows on
   * the link's page; the token comes to this tab's {@link emailStatus} poll.
   */
  emailBegin(input: { purpose: StepUpPurpose }): Promise<StepUpEmailRequest>;
  /**
   * Polls the request with its claim secret. `complete` carries the step-up
   * token, once. A refusal answers `expired`; a rate limit, a server error or
   * no answer throws, and the caller polls again.
   */
  emailStatus(input: { requestId: string; claimSecret: string }): Promise<StepUpEmailStatus>;
  /** Another link for the same request. `limit` once it has sent all it may. */
  emailResend(input: {
    requestId: string;
    claimSecret: string;
  }): Promise<{ status: "sent" | "limit" | "expired" }>;
  /**
   * Exchange a code from the account's authenticator app for a step-up token.
   *
   * There is no `totpBegin`: TOTP is challenge-free, so there is nothing for
   * the server to mint or park. Whether this factor is available at all is what
   * `TotpClient.status` answers.
   */
  totpComplete(input: { code: string; purpose?: StepUpPurpose }): Promise<StepUpToken>;
}

async function postJson<T>(authFetch: AuthFetch, url: string, body: unknown): Promise<T> {
  const res = await reach(
    StepUpError,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
    authFetch,
  );
  return readJson<T>(StepUpError, res);
}

/** The fields the link routes answer with; anything else in the body is ignored. */
interface LinkAnswer {
  readonly status?: unknown;
  readonly pairingCode?: unknown;
  readonly step_up_token?: unknown;
  readonly expires_in?: unknown;
}

/**
 * POSTs a step-up link call. Null for a refusal of the request (a 4xx other
 * than a rate limit); throws on a rate limit, a server error or no answer,
 * which a poll retries.
 */
async function postLinkCall(
  authFetch: AuthFetch,
  url: string,
  body: unknown,
): Promise<LinkAnswer | null> {
  const res = await reach(
    StepUpError,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
    authFetch,
  );
  if (res.status === 429 || res.status >= 500) {
    throw new StepUpError(`Request failed: ${res.status}`, res.status);
  }
  if (!res.ok) return null;
  return readJson<LinkAnswer>(StepUpError, res);
}

function toToken(raw: { step_up_token: string; expires_in: number }): StepUpToken {
  return {
    token: raw.step_up_token,
    expiresIn: raw.expires_in,
  };
}

export function createStepUpClient(config: StepUpClientConfig): StepUpClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    passkeyBegin: () =>
      postJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        authFetch,
        `${base}/step-up/passkey/begin`,
        {},
      ),
    passkeyComplete: async (input) =>
      toToken(
        await postJson<{ step_up_token: string; expires_in: number }>(
          authFetch,
          `${base}/step-up/passkey/complete`,
          // `JSON.stringify` drops an undefined `purpose`, so an unbound
          // ceremony still posts the legacy body shape.
          { assertion: input.assertion, purpose: input.purpose },
        ),
      ),
    emailBegin: async (input) => {
      const raw = await postJson<Partial<StepUpEmailRequest>>(
        authFetch,
        `${base}/step-up/email/begin`,
        { purpose: input.purpose },
      );
      if (
        typeof raw.requestId !== "string" ||
        typeof raw.claimSecret !== "string" ||
        typeof raw.pairingCode !== "string" ||
        typeof raw.expiresAt !== "number"
      ) {
        throw new StepUpError("Unexpected step-up answer", 200);
      }
      return {
        requestId: raw.requestId,
        claimSecret: raw.claimSecret,
        pairingCode: raw.pairingCode,
        expiresAt: raw.expiresAt,
      };
    },
    emailStatus: async (input) => {
      const raw = await postLinkCall(
        authFetch,
        `${base}/step-up/email/${encodeURIComponent(input.requestId)}/status`,
        { claimSecret: input.claimSecret },
      );
      if (raw === null || raw.status === "expired") return { status: "expired" };
      if (raw.status === "pending") {
        return typeof raw.pairingCode === "string"
          ? { status: "pending", pairingCode: raw.pairingCode }
          : { status: "pending" };
      }
      if (
        raw.status !== "complete" ||
        typeof raw.step_up_token !== "string" ||
        typeof raw.expires_in !== "number"
      ) {
        throw new StepUpError("Unexpected step-up status", 200);
      }
      return {
        status: "complete",
        token: { token: raw.step_up_token, expiresIn: raw.expires_in },
      };
    },
    emailResend: async (input) => {
      const raw = await postLinkCall(
        authFetch,
        `${base}/step-up/email/${encodeURIComponent(input.requestId)}/resend`,
        { claimSecret: input.claimSecret },
      );
      const status = raw?.status;
      return status === "sent" || status === "limit" ? { status } : { status: "expired" };
    },
    totpComplete: async (input) =>
      toToken(
        await postJson<{ step_up_token: string; expires_in: number }>(
          authFetch,
          `${base}/step-up/totp/complete`,
          { code: input.code, purpose: input.purpose },
        ),
      ),
  };
}
