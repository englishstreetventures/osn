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
  | "pulse_app_delete"
  | "zap_app_delete";

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
  passkeyBegin(input: { accessToken: string }): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
  }>;
  passkeyComplete(input: {
    accessToken: string;
    assertion: unknown;
    /** Binds the minted token to one ceremony. Omit only for legacy gates. */
    purpose?: StepUpPurpose;
  }): Promise<StepUpToken>;
  /** Sends an OTP to the authenticated account's verified email. */
  otpBegin(input: { accessToken: string }): Promise<{ sent: true }>;
  otpComplete(input: {
    accessToken: string;
    code: string;
    purpose?: StepUpPurpose;
  }): Promise<StepUpToken>;
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

function toToken(raw: { step_up_token: string; expires_in: number }): StepUpToken {
  return {
    token: raw.step_up_token,
    expiresIn: raw.expires_in,
  };
}

export function createStepUpClient(config: StepUpClientConfig): StepUpClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    passkeyBegin: (input) =>
      postJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        `${base}/step-up/passkey/begin`,
        input.accessToken,
        {},
      ),
    passkeyComplete: async (input) =>
      toToken(
        await postJson<{ step_up_token: string; expires_in: number }>(
          `${base}/step-up/passkey/complete`,
          input.accessToken,
          // `JSON.stringify` drops an undefined `purpose`, so an unbound
          // ceremony still posts the legacy body shape.
          { assertion: input.assertion, purpose: input.purpose },
        ),
      ),
    otpBegin: (input) =>
      postJson<{ sent: true }>(`${base}/step-up/otp/begin`, input.accessToken, {}),
    otpComplete: async (input) =>
      toToken(
        await postJson<{ step_up_token: string; expires_in: number }>(
          `${base}/step-up/otp/complete`,
          input.accessToken,
          { code: input.code, purpose: input.purpose },
        ),
      ),
  };
}
