import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for the sign-in flow. Mirrors `createRegistrationClient`:
 * no Effect. The server's `/login/*` endpoints return a session directly,
 * which the UI layer can hand straight to `AuthProvider.adoptSession`.
 *
 * The WebAuthn browser ceremony (`startAuthentication`) is intentionally
 * performed by the caller — keeping it caller-side avoids pulling
 * `@simplewebauthn/browser` into `@osn/client`.
 */

export interface LoginClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * The publicly-safe profile subset returned alongside a fresh session by the
 * `/login/*` endpoints. Matches `PublicProfile` in `@osn/core`.
 */
export interface LoginProfile {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface LoginResult {
  session: Session;
  profile: LoginProfile;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new LoginError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export interface LoginClient {
  /**
   * Begin passkey login. Pass a handle / email for the identifier-bound
   * flow, or omit to kick off the discoverable-credential (conditional-UI)
   * flow — in that case the response carries a `challengeId` the caller
   * must pass to `passkeyComplete`.
   */
  passkeyBegin(identifier?: string): Promise<{ options: unknown; challengeId?: string }>;
  /** Complete passkey login — exchange a signed assertion for a session. */
  passkeyComplete(
    input: { identifier: string; assertion: unknown } | { challengeId: string; assertion: unknown },
  ): Promise<LoginResult>;
  /** Send a 6-digit OTP code to the identifier's email. Always resolves to { sent: true }. */
  otpBegin(identifier: string): Promise<{ sent: true }>;
  /** Exchange a 6-digit OTP code for a session. */
  otpComplete(identifier: string, code: string): Promise<LoginResult>;
  /** Send a magic sign-in link to the identifier's email. Always resolves to { sent: true }. */
  magicBegin(identifier: string): Promise<{ sent: true }>;
  /** Exchange a magic-link token (from the emailed link's query string) for a session. */
  magicVerify(token: string): Promise<LoginResult>;
}

export function createLoginClient(config: LoginClientConfig): LoginClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const toLoginResult = (raw: { session: unknown; profile: LoginProfile }): LoginResult => ({
    session: parseTokenResponse(raw.session),
    profile: raw.profile,
  });

  return {
    passkeyBegin: (identifier) =>
      postJson<{ options: unknown; challengeId?: string }>(
        `${base}/login/passkey/begin`,
        identifier === undefined ? {} : { identifier },
      ),

    passkeyComplete: async (input) => {
      const raw = await postJson<{ session: unknown; profile: LoginProfile }>(
        `${base}/login/passkey/complete`,
        input,
      );
      return toLoginResult(raw);
    },

    otpBegin: (identifier) => postJson<{ sent: true }>(`${base}/login/otp/begin`, { identifier }),

    otpComplete: async (identifier, code) => {
      const raw = await postJson<{ session: unknown; profile: LoginProfile }>(
        `${base}/login/otp/complete`,
        { identifier, code },
      );
      return toLoginResult(raw);
    },

    magicBegin: (identifier) =>
      postJson<{ sent: true }>(`${base}/login/magic/begin`, { identifier }),

    magicVerify: async (token) => {
      // S-H1: token goes in the body, never in the URL.
      const raw = await postJson<{ session: unknown; profile: LoginProfile }>(
        `${base}/login/magic/verify`,
        { token },
      );
      return toLoginResult(raw);
    },
  };
}
