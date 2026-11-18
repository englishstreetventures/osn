/**
 * TOTP (RFC 6238) client helpers — enrol an authenticator app, confirm it,
 * report on it, remove it.
 *
 * Enrolling and removing are both step-up gated, so a caller drives a step-up
 * ceremony first (see `./step-up`) and passes the resulting token. The purposes
 * are `totp_enroll` and `totp_disable`; a token minted for any other ceremony
 * is refused.
 *
 * Consuming a TOTP code to obtain a step-up token is the other direction, and
 * lives on `StepUpClient.totpComplete`.
 */

import { OsnApiError } from "./api-error";
import { reach, readJson } from "./auth-fetch";
import type { AuthFetch } from "./runtime";

export interface TotpClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

export class TotpError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = "TotpError";
  }
}

export interface TotpEnrollment {
  /**
   * The `otpauth://` URI to render as a QR code.
   *
   * **Secret material** — it carries the whole shared secret. Show it, do not
   * log it, do not persist it, and do not put it anywhere a crash reporter will
   * pick it up.
   */
  otpauthUri: string;
  /** The same secret as base32, for a user typing it in by hand. Also secret. */
  totpSecret: string;
}

export interface TotpStatus {
  enrolled: boolean;
  label: string | null;
  /** Unix seconds, or null when it has never been used. */
  lastUsedAt: number | null;
  /** Unix seconds, or null when nothing is enrolled. */
  createdAt: number | null;
}

/**
 * A rejection of `authFetch` about the session, or the caller's abort,
 * reaches the caller unchanged (`./auth-fetch.ts`); every other failure is
 * a `TotpError`.
 */
export interface TotpClient {
  /**
   * Start enrolment: mints a secret and returns it once. Requires a step-up
   * token minted with purpose `totp_enroll`. Nothing is stored against the
   * account until {@link TotpClient.enrollComplete} proves possession.
   */
  enrollBegin(input: { stepUpToken: string }): Promise<TotpEnrollment>;
  /**
   * Finish enrolment with the first code from the authenticator. That code is
   * consumed by the act of enrolling, so the next ceremony needs the next one.
   */
  enrollComplete(input: { code: string; label?: string }): Promise<{ enrolled: boolean }>;
  /**
   * Remove the credential. Requires a step-up token minted with purpose
   * `totp_disable`. Idempotent: removing nothing answers `{ disabled: false }`.
   */
  disable(input: { stepUpToken: string }): Promise<{ disabled: boolean }>;
  /** Whether the account has a confirmed authenticator. Never returns a secret. */
  status(): Promise<TotpStatus>;
}

async function request<T>(
  authFetch: AuthFetch,
  url: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  };
  // A GET carries no body at all — `fetch` rejects one outright.
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await reach(TotpError, url, init, authFetch);
  return readJson<T>(TotpError, res);
}

export function createTotpClient(config: TotpClientConfig): TotpClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    enrollBegin: (input) =>
      request<TotpEnrollment>(authFetch, `${base}/totp/enroll/begin`, "POST", {
        step_up_token: input.stepUpToken,
      }),
    enrollComplete: (input) =>
      request<{ enrolled: boolean }>(authFetch, `${base}/totp/enroll/complete`, "POST", {
        code: input.code,
        // `JSON.stringify` drops an undefined label, so an unlabelled
        // enrolment posts the body the server treats as "no label".
        label: input.label,
      }),
    disable: (input) =>
      request<{ disabled: boolean }>(authFetch, `${base}/totp`, "DELETE", {
        step_up_token: input.stepUpToken,
      }),
    status: () => request<TotpStatus>(authFetch, `${base}/totp/status`, "GET"),
  };
}
