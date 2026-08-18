import { sessionFetch } from "./session-fetch";
import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for the email-verified registration flow + first-
 * passkey enrollment. Kept separate from the Effect-based `OsnAuth` service
 * so UI components can use these directly without dragging in the Storage
 * layer.
 *
 * Flow:
 *  1. `checkHandle(handle)`                — front-end "is this @ free?" probe
 *  2. `beginRegistration(...)`             — sends a 6-digit OTP to the email
 *  3. `completeRegistration(...)`          — verifies the OTP, creates the
 *                                            account + profile, and returns
 *                                            `{ profileId, session }`. The
 *                                            session is ready to hand to
 *                                            `AuthProvider.adoptSession`.
 *  4. `passkeyRegisterBegin({profileId, accessToken})`  — fetch WebAuthn
 *                                            options. Pass the access
 *                                            token returned in step 3.
 *  5. `passkeyRegisterComplete({profileId,accessToken,attestation})` —
 *                                            submit the attested
 *                                            credential. The server
 *                                            derives the caller's session
 *                                            token from the HttpOnly
 *                                            cookie (S-H1); no body field
 *                                            for it here.
 *
 * Adding a SECOND passkey post-registration requires a `stepUpToken` on
 * `passkeyRegisterBegin` (S-H1) — pass one minted by the step-up client.
 * The first-passkey bootstrap flow from `completeRegistration` never
 * needs it because the account has no credentials yet.
 *
 * The WebAuthn browser ceremony is intentionally not performed inside this
 * package — keeping it caller-side avoids pulling in @simplewebauthn/browser.
 *
 * The UI MUST complete step 5 before dismissing the registration flow.
 * Together with the last-passkey guard in `DELETE /passkeys/:id`, this
 * maintains the invariant "every live account has ≥1 WebAuthn credential".
 */

export interface RegistrationClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  options: { bearer?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.bearer) headers["Authorization"] = `Bearer ${options.bearer}`;
  // `sessionFetch` because `/register/complete` sets the refresh cookie; see
  // `./session-fetch.ts` for why iOS cannot take it through the webview.
  //
  // `credentials: "include"` is not optional here, and it is the whole reason
  // registration produces a usable session. The issuer is a DIFFERENT ORIGIN
  // from every app that calls it (`musubi.social` → `id.musubi.social`), and a
  // cross-origin fetch left on the default `same-origin` credentials mode does
  // not process the response's `Set-Cookie` at all. `/register/complete` returns
  // the refresh token ONLY as an HttpOnly cookie (S-M1 — the body carries the
  // access token and nothing else), so dropping that header silently ended
  // registration with an in-memory access token and no session: a reload signed
  // the new account straight back out, and an OIDC `prompt=create` flow bounced
  // to the consent screen's sign-up panel again because `/authorize/context`
  // still saw a signed-out browser. Every other cookie-setting route in this
  // package (`login`, `recovery`, `/token`) already sends it.
  const res = await sessionFetch(url, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new RegistrationError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export interface CompleteRegistrationResult {
  profileId: string;
  handle: string;
  email: string;
  /** Ready to pass to AuthProvider.adoptSession. */
  session: Session;
}

export interface RegistrationClient {
  /**
   * "Is this @ free?" probe. Pass an `AbortSignal` so debounced callers can
   * cancel the previous in-flight probe before issuing a new one (P-W10) —
   * an aborted call rejects with the fetch `AbortError`.
   */
  checkHandle(handle: string, signal?: AbortSignal): Promise<{ available: boolean }>;
  beginRegistration(input: {
    email: string;
    handle: string;
    /**
     * Date of birth, `YYYY-MM-DD` (C-H8 / COPPA). The server hard-rejects
     * under-13 with HTTP 422 before sending the OTP; the value is never stored.
     */
    birthdate: string;
    displayName?: string;
    /**
     * Cloudflare Turnstile token. Sent to `/register/begin` when the UI rendered
     * the widget. Optional: osn-api only requires it when its
     * `TURNSTILE_SECRET_KEY` is configured (fail-closed there); unset ⇒ ignored.
     */
    turnstileToken?: string;
  }): Promise<{ sent: boolean }>;
  completeRegistration(input: { email: string; code: string }): Promise<CompleteRegistrationResult>;
  /** WebAuthn options for the first-passkey enrollment. `accessToken` is the one returned by `completeRegistration`. */
  /**
   * Fetch WebAuthn options. `stepUpToken` is REQUIRED by the server when
   * the account already has ≥1 passkey (S-H1); the first-passkey
   * bootstrap flow from `completeRegistration` can omit it.
   *
   * Returns the server's creation options verbatim — feed them straight to
   * `navigator.credentials.create` (or `startRegistration` from
   * @simplewebauthn/browser, which takes the same JSON shape).
   */
  passkeyRegisterBegin(input: {
    profileId: string;
    accessToken: string;
    stepUpToken?: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  passkeyRegisterComplete(input: {
    profileId: string;
    accessToken: string;
    attestation: unknown;
  }): Promise<{ passkeyId: string }>;
}

export function createRegistrationClient(config: RegistrationClientConfig): RegistrationClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const checkHandle = async (handle: string, signal?: AbortSignal) => {
    const res = await fetch(
      `${base}/handle/${encodeURIComponent(handle)}`,
      signal ? { signal } : undefined,
    );
    const json = (await res.json()) as { available?: boolean; error?: string };
    if (!res.ok || typeof json.available !== "boolean") {
      throw new RegistrationError(json.error ?? "Invalid handle");
    }
    return { available: json.available };
  };

  const beginRegistration = (input: {
    email: string;
    handle: string;
    birthdate: string;
    displayName?: string;
    turnstileToken?: string;
  }) => postJson<{ sent: boolean }>(`${base}/register/begin`, input);

  const completeRegistration = async (input: {
    email: string;
    code: string;
  }): Promise<CompleteRegistrationResult> => {
    const raw = await postJson<{
      profileId: string;
      handle: string;
      email: string;
      session: unknown;
    }>(`${base}/register/complete`, input);
    const session = parseTokenResponse(raw.session);
    return {
      profileId: raw.profileId,
      handle: raw.handle,
      email: raw.email,
      session,
    };
  };

  const passkeyRegisterBegin = (input: {
    profileId: string;
    accessToken: string;
    stepUpToken?: string;
  }) =>
    postJson<PublicKeyCredentialCreationOptionsJSON>(
      `${base}/passkey/register/begin`,
      input.stepUpToken !== undefined
        ? { profileId: input.profileId, step_up_token: input.stepUpToken }
        : { profileId: input.profileId },
      { bearer: input.accessToken },
    );

  const passkeyRegisterComplete = (input: {
    profileId: string;
    accessToken: string;
    attestation: unknown;
  }) =>
    postJson<{ passkeyId: string }>(
      `${base}/passkey/register/complete`,
      { profileId: input.profileId, attestation: input.attestation },
      { bearer: input.accessToken },
    );

  return {
    checkHandle,
    beginRegistration,
    completeRegistration,
    passkeyRegisterBegin,
    passkeyRegisterComplete,
  };
}
