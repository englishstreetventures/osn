import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for the first-party sign-in flow. Mirrors
 * `createRegistrationClient`: no Effect, no PKCE state, no authorization
 * code round-trip. The server's `/login/*` endpoints return a session
 * directly, which the UI layer can hand straight to `AuthProvider.adoptSession`.
 *
 * Third-party apps that still want the PKCE redirect flow can continue to
 * drive `OsnAuthService.startLogin` / `handleCallback` in `./service`.
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
 * The publicly-safe User subset returned alongside a fresh session by the
 * `/login/*` endpoints. Matches `PublicUser` in `@osn/core`.
 */
export interface LoginUser {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface LoginResult {
  session: Session;
  user: LoginUser;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new LoginError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new LoginError(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
}

export interface LoginClient {
  /** Begin passkey login — returns the WebAuthn assertion challenge options. */
  passkeyBegin(identifier: string): Promise<{ options: unknown }>;
  /** Complete passkey login — exchange a signed assertion for a session. */
  passkeyComplete(identifier: string, assertion: unknown): Promise<LoginResult>;
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

  const toLoginResult = (raw: { session: unknown; user: LoginUser }): LoginResult => ({
    session: parseTokenResponse(raw.session),
    user: raw.user,
  });

  return {
    passkeyBegin: (identifier) =>
      postJson<{ options: unknown }>(`${base}/login/passkey/begin`, { identifier }),

    passkeyComplete: async (identifier, assertion) => {
      const raw = await postJson<{ session: unknown; user: LoginUser }>(
        `${base}/login/passkey/complete`,
        { identifier, assertion },
      );
      return toLoginResult(raw);
    },

    otpBegin: (identifier) => postJson<{ sent: true }>(`${base}/login/otp/begin`, { identifier }),

    otpComplete: async (identifier, code) => {
      const raw = await postJson<{ session: unknown; user: LoginUser }>(
        `${base}/login/otp/complete`,
        { identifier, code },
      );
      return toLoginResult(raw);
    },

    magicBegin: (identifier) =>
      postJson<{ sent: true }>(`${base}/login/magic/begin`, { identifier }),

    magicVerify: async (token) => {
      const raw = await getJson<{ session: unknown; user: LoginUser }>(
        `${base}/login/magic/verify?token=${encodeURIComponent(token)}`,
      );
      return toLoginResult(raw);
    },
  };
}
