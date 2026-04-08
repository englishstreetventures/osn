import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for the email-verified registration flow + passkey
 * enrolment. Kept separate from the Effect-based OsnAuth service so consumers
 * can use these directly from UI components without dragging in the Storage
 * layer.
 *
 * Flow:
 *  1. checkHandle(handle)             — front-end "is this @ free?" check
 *  2. beginRegistration(...)          — sends a 6-digit OTP to the email
 *  3. completeRegistration(...)       — verifies the OTP, creates the user,
 *                                       and returns { userId, session,
 *                                       enrollmentToken } in a single
 *                                       response. The session is ready to
 *                                       hand to AuthProvider.adoptSession.
 *  4. passkeyRegisterBegin({userId,enrollmentToken})  — fetch WebAuthn options
 *  5. passkeyRegisterComplete({userId,enrollmentToken,attestation}) — submit
 *
 * The WebAuthn browser ceremony is intentionally not performed inside this
 * package — keeping it caller-side avoids adding @simplewebauthn/browser as a
 * dependency of @osn/client.
 *
 * Notes:
 *  - There is NO `exchangeAuthCode` step. The previous design routed through
 *    /token with a literal `code_verifier: "registration"` and no `state`,
 *    which exploited a pre-existing PKCE bypass at /token. The bypass is now
 *    out of the registration code path entirely.
 *  - Both passkey calls require an Authorization: Bearer header carrying the
 *    enrollment token returned from completeRegistration. The server compares
 *    the token's `sub` against the body `userId` and rejects mismatches.
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
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new RegistrationError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export interface CompleteRegistrationResult {
  userId: string;
  handle: string;
  email: string;
  /** Ready to pass to AuthProvider.adoptSession. */
  session: Session;
  /** Single-use bearer token for /passkey/register/{begin,complete}. */
  enrollmentToken: string;
}

export interface RegistrationClient {
  checkHandle(handle: string): Promise<{ available: boolean }>;
  beginRegistration(input: {
    email: string;
    handle: string;
    displayName?: string;
  }): Promise<{ sent: boolean }>;
  completeRegistration(input: { email: string; code: string }): Promise<CompleteRegistrationResult>;
  passkeyRegisterBegin(input: { userId: string; enrollmentToken: string }): Promise<unknown>;
  passkeyRegisterComplete(input: {
    userId: string;
    enrollmentToken: string;
    attestation: unknown;
  }): Promise<{ passkeyId: string }>;
}

export function createRegistrationClient(config: RegistrationClientConfig): RegistrationClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const checkHandle = async (handle: string) => {
    const res = await fetch(`${base}/handle/${encodeURIComponent(handle)}`);
    const json = (await res.json()) as { available?: boolean; error?: string };
    if (!res.ok || typeof json.available !== "boolean") {
      throw new RegistrationError(json.error ?? "Invalid handle");
    }
    return { available: json.available };
  };

  const beginRegistration = (input: { email: string; handle: string; displayName?: string }) =>
    postJson<{ sent: boolean }>(`${base}/register/begin`, input);

  const completeRegistration = async (input: {
    email: string;
    code: string;
  }): Promise<CompleteRegistrationResult> => {
    const raw = await postJson<{
      userId: string;
      handle: string;
      email: string;
      session: unknown;
      enrollment_token: string;
    }>(`${base}/register/complete`, input);
    const session = parseTokenResponse(raw.session);
    return {
      userId: raw.userId,
      handle: raw.handle,
      email: raw.email,
      session,
      enrollmentToken: raw.enrollment_token,
    };
  };

  const passkeyRegisterBegin = (input: { userId: string; enrollmentToken: string }) =>
    postJson<unknown>(
      `${base}/passkey/register/begin`,
      { userId: input.userId },
      { bearer: input.enrollmentToken },
    );

  const passkeyRegisterComplete = (input: {
    userId: string;
    enrollmentToken: string;
    attestation: unknown;
  }) =>
    postJson<{ passkeyId: string }>(
      `${base}/passkey/register/complete`,
      { userId: input.userId, attestation: input.attestation },
      { bearer: input.enrollmentToken },
    );

  return {
    checkHandle,
    beginRegistration,
    completeRegistration,
    passkeyRegisterBegin,
    passkeyRegisterComplete,
  };
}
