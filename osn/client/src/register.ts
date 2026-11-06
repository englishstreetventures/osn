import { OsnApiError } from "./api-error";
import { reach, readJson, responseError } from "./auth-fetch";
import { safeJson } from "./response-body";
import { sessionFetch } from "./session-fetch";
import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for sign-up through an emailed link + first-passkey
 * enrollment. Kept separate from the Effect-based `OsnAuth` service so UI
 * components can use these directly without dragging in the Storage layer.
 *
 * Flow:
 *  1. `checkHandle(handle)`                — front-end "is this @ free?" probe
 *  2. `beginRegistration(...)`             — mails a link to the address and
 *                                            answers `{ requestId, claimSecret,
 *                                            pairingCode, expiresAt }`. The tab
 *                                            keeps the claim secret and shows
 *                                            the pairing code, which the link's
 *                                            confirm step requires.
 *  3. `registrationStatus(...)`            — polled with the claim secret;
 *                                            once the link is confirmed (on
 *                                            any device) it creates the
 *                                            account + profile and returns
 *                                            `{ profileId, session }`. The
 *                                            session is ready to hand to
 *                                            `AuthProvider.adoptSession`.
 *     `resendRegistrationLink(...)`        — another link for the same request.
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
 * The first-passkey bootstrap flow after `registrationStatus` never needs it
 * because the account has no credentials yet.
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

export class RegistrationError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = "RegistrationError";
  }
}

/**
 * Request headers as `fetch` wants them. Named rather than `Record<string,
 * string>` so the optional `Authorization` can be assigned after the fact
 * without the literal losing its evidence.
 */
interface JsonHeaders {
  [name: string]: string;
}

async function postJson<T>(
  url: string,
  body: unknown,
  options: { bearer?: string } = {},
): Promise<T> {
  const headers: JsonHeaders = { "Content-Type": "application/json" };
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  // `sessionFetch` because the completing `/register/:requestId/status` sets
  // the refresh cookie; see `./session-fetch.ts` for why iOS cannot take it
  // through the webview.
  //
  // `credentials: "include"` is not optional here, and it is the whole reason
  // registration produces a usable session. The issuer is a DIFFERENT ORIGIN
  // from every app that calls it (`musubi.social` → `id.musubi.social`), and a
  // cross-origin fetch left on the default `same-origin` credentials mode does
  // not process the response's `Set-Cookie` at all. The completing status poll
  // returns the refresh token ONLY as an HttpOnly cookie (the body carries the
  // access token and nothing else), so dropping that header would end
  // registration with an in-memory access token and no session: a reload would
  // sign the new account straight back out, and an OIDC `prompt=create` flow
  // would bounce to the consent screen's sign-up panel again because
  // `/authorize/context` would still see a signed-out browser. Every other
  // cookie-setting route in this package (`login`, `recovery`, `/token`) sends
  // it too.
  const res = await reach(
    RegistrationError,
    url,
    { method: "POST", headers, credentials: "include", body: JSON.stringify(body) },
    sessionFetch,
  );
  return readJson<T>(RegistrationError, res);
}

/** A sign-up the tab began: what it keeps, and the number it shows. */
export interface BegunRegistration {
  readonly requestId: string;
  /** Kept by this tab alone; whoever holds it receives the account's session. */
  readonly claimSecret: string;
  /** Shown while waiting: the link's confirm step requires it. */
  readonly pairingCode: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** A sign-up the tab began before and is replacing. */
export interface PreviousRegistration {
  readonly requestId: string;
  readonly claimSecret: string;
}

export interface CompleteRegistrationResult {
  profileId: string;
  handle: string;
  email: string;
  /** Ready to pass to AuthProvider.adoptSession. */
  session: Session;
}

/**
 * What a status poll learned: still waiting, gone (every refusal, and a
 * request someone else's poll finished), the handle taken while waiting, or
 * the account made.
 */
export type RegistrationStatus =
  | { readonly status: "pending" }
  | { readonly status: "expired" }
  | { readonly status: "conflict" }
  | ({ readonly status: "complete" } & CompleteRegistrationResult);

export interface RegistrationClient {
  /**
   * "Is this @ free?" probe. Pass an `AbortSignal` so debounced callers can
   * cancel the previous in-flight probe before issuing a new one (P-W10) —
   * an aborted call rejects with the fetch `AbortError`.
   */
  checkHandle(handle: string, signal?: AbortSignal): Promise<{ available: boolean }>;
  /**
   * Begins a sign-up: mails a link to `email` and answers the request this
   * tab holds. It answers the same whether or not the address or handle is
   * taken; a taken one's link is simply never sent.
   */
  beginRegistration(input: {
    email: string;
    handle: string;
    /**
     * Date of birth, `YYYY-MM-DD` (C-H8 / COPPA). The server hard-rejects
     * under-13 with HTTP 422 before sending the link; the value is never stored.
     */
    birthdate: string;
    displayName?: string;
    /**
     * Cloudflare Turnstile token. Sent to `/register/begin` when the UI rendered
     * the widget. Optional: osn-api only requires it when its
     * `TURNSTILE_SECRET_KEY` is configured (fail-closed there); unset ⇒ ignored.
     */
    turnstileToken?: string;
    /** A sign-up this tab began before: retired first, so its address is free again. */
    previous?: PreviousRegistration;
  }): Promise<BegunRegistration>;
  /**
   * Polls the sign-up. A refusal answers `expired`; a rate limit, a server
   * error or no answer throws, and the caller polls again later.
   */
  registrationStatus(input: PreviousRegistration): Promise<RegistrationStatus>;
  /** Another link for the same request. `limit` once it has sent all it may. */
  resendRegistrationLink(
    input: PreviousRegistration,
  ): Promise<{ status: "sent" | "limit" | "expired" }>;
  /** WebAuthn options for the first-passkey enrollment. `accessToken` is the one `registrationStatus` returned. */
  /**
   * Fetch WebAuthn options. `stepUpToken` is REQUIRED by the server when
   * the account already has ≥1 passkey (S-H1); the first-passkey
   * bootstrap flow after `registrationStatus` can omit it.
   *
   * Returns the server's creation options verbatim — feed them straight to
   * `navigator.credentials.create` (or `startRegistration` from
   * `@simplewebauthn/browser`, which takes the same JSON shape).
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
    const res = await reach(
      RegistrationError,
      `${base}/handle/${encodeURIComponent(handle)}`,
      signal ? { signal } : undefined,
    );
    const json = await safeJson<{ available?: boolean }>(res);
    if (typeof json?.available === "boolean" && res.ok) return { available: json.available };
    const err = responseError(RegistrationError, res, json);
    // A refusal with no message of its own reads "Invalid handle", not "Request failed".
    if (typeof json?.error === "string" && json.error.length > 0) throw err;
    throw new RegistrationError("Invalid handle", err.status, err.code);
  };

  const beginRegistration = (input: Parameters<RegistrationClient["beginRegistration"]>[0]) =>
    postJson<BegunRegistration>(`${base}/register/begin`, input);

  const registrationStatus = async (input: PreviousRegistration): Promise<RegistrationStatus> => {
    const res = await reach(
      RegistrationError,
      `${base}/register/${encodeURIComponent(input.requestId)}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The completing answer sets the refresh cookie; see `postJson`.
        credentials: "include",
        body: JSON.stringify({ claimSecret: input.claimSecret }),
      },
      sessionFetch,
    );
    if (res.status === 429 || res.status >= 500) {
      throw responseError(RegistrationError, res, await safeJson(res));
    }
    if (!res.ok) return { status: "expired" };
    const raw = await readJson<{
      status: string;
      profileId?: string;
      handle?: string;
      email?: string;
      session?: unknown;
    }>(RegistrationError, res);
    if (raw.status === "pending" || raw.status === "expired" || raw.status === "conflict") {
      return { status: raw.status };
    }
    if (raw.status !== "complete" || !raw.profileId || !raw.handle || !raw.email) {
      throw responseError(RegistrationError, res, raw);
    }
    return {
      status: "complete",
      profileId: raw.profileId,
      handle: raw.handle,
      email: raw.email,
      session: parseTokenResponse(raw.session),
    };
  };

  const resendRegistrationLink = (input: PreviousRegistration) =>
    postJson<{ status: "sent" | "limit" | "expired" }>(
      `${base}/register/${encodeURIComponent(input.requestId)}/resend`,
      { claimSecret: input.claimSecret },
    );

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
    registrationStatus,
    resendRegistrationLink,
    passkeyRegisterBegin,
    passkeyRegisterComplete,
  };
}
