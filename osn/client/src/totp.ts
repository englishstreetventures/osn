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

export interface TotpClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
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

export interface TotpClient {
  /**
   * Start enrolment: mints a secret and returns it once. Requires a step-up
   * token minted with purpose `totp_enroll`. Nothing is stored against the
   * account until {@link TotpClient.enrollComplete} proves possession.
   */
  enrollBegin(input: { accessToken: string; stepUpToken: string }): Promise<TotpEnrollment>;
  /**
   * Finish enrolment with the first code from the authenticator. That code is
   * consumed by the act of enrolling, so the next ceremony needs the next one.
   */
  enrollComplete(input: {
    accessToken: string;
    code: string;
    label?: string;
  }): Promise<{ enrolled: boolean }>;
  /**
   * Remove the credential. Requires a step-up token minted with purpose
   * `totp_disable`. Idempotent: removing nothing answers `{ disabled: false }`.
   */
  disable(input: { accessToken: string; stepUpToken: string }): Promise<{ disabled: boolean }>;
  /** Whether the account has a confirmed authenticator. Never returns a secret. */
  status(input: { accessToken: string }): Promise<TotpStatus>;
}

async function request<T>(
  url: string,
  bearer: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    credentials: "include",
  };
  // A GET carries no body at all — `fetch` rejects one outright.
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new TotpError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export function createTotpClient(config: TotpClientConfig): TotpClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    enrollBegin: (input) =>
      request<TotpEnrollment>(`${base}/totp/enroll/begin`, input.accessToken, "POST", {
        step_up_token: input.stepUpToken,
      }),
    enrollComplete: (input) =>
      request<{ enrolled: boolean }>(`${base}/totp/enroll/complete`, input.accessToken, "POST", {
        code: input.code,
        // `JSON.stringify` drops an undefined label, so an unlabelled
        // enrolment posts the body the server treats as "no label".
        label: input.label,
      }),
    disable: (input) =>
      request<{ disabled: boolean }>(`${base}/totp`, input.accessToken, "DELETE", {
        step_up_token: input.stepUpToken,
      }),
    status: (input) => request<TotpStatus>(`${base}/totp/status`, input.accessToken, "GET"),
  };
}
