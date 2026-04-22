/**
 * Step-up (sudo) client helpers.
 *
 * Step-up is a short-lived high-assurance ceremony required by sensitive
 * endpoints (recovery-code generation, email change). The client fetches
 * a step-up token via a passkey or OTP flow and attaches it — typically
 * as `step_up_token` in the request body — to the gated call.
 *
 * The WebAuthn browser ceremony (`startAuthentication`) is intentionally
 * left to the caller so `@osn/client` stays free of
 * `@simplewebauthn/browser` as a runtime dep.
 */

export interface StepUpClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class StepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpError";
  }
}

export interface StepUpToken {
  token: string;
  /** Seconds until the step-up token expires. */
  expiresIn: number;
}

export interface StepUpClient {
  /**
   * Fetch a WebAuthn assertion challenge scoped to the authenticated
   * account. The caller drives the browser ceremony with the returned
   * `options`, then calls `passkeyComplete`.
   */
  passkeyBegin(input: { accessToken: string }): Promise<{ options: unknown }>;
  passkeyComplete(input: { accessToken: string; assertion: unknown }): Promise<StepUpToken>;
  /** Sends an OTP to the authenticated account's verified email. */
  otpBegin(input: { accessToken: string }): Promise<{ sent: true }>;
  otpComplete(input: { accessToken: string; code: string }): Promise<StepUpToken>;
}

async function postJson<T>(url: string, bearer: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new StepUpError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export function createStepUpClient(config: StepUpClientConfig): StepUpClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const toToken = (raw: { step_up_token: string; expires_in: number }): StepUpToken => ({
    token: raw.step_up_token,
    expiresIn: raw.expires_in,
  });

  return {
    passkeyBegin: (input) =>
      postJson<{ options: unknown }>(`${base}/step-up/passkey/begin`, input.accessToken, {}),
    passkeyComplete: async (input) =>
      toToken(
        await postJson<{ step_up_token: string; expires_in: number }>(
          `${base}/step-up/passkey/complete`,
          input.accessToken,
          { assertion: input.assertion },
        ),
      ),
    otpBegin: (input) =>
      postJson<{ sent: true }>(`${base}/step-up/otp/begin`, input.accessToken, {}),
    otpComplete: async (input) =>
      toToken(
        await postJson<{ step_up_token: string; expires_in: number }>(
          `${base}/step-up/otp/complete`,
          input.accessToken,
          { code: input.code },
        ),
      ),
  };
}
