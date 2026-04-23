import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for the sign-in flow. WebAuthn (passkey or security
 * key) is the only primary login factor; "lost device" recovery lives in
 * `./recovery.ts`.
 *
 * The browser-side WebAuthn ceremony (`startAuthentication`) is
 * intentionally performed by the caller so `@osn/client` doesn't pull in
 * `@simplewebauthn/browser`.
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
 * The publicly-safe profile subset returned alongside a fresh session by
 * `/login/passkey/complete`. Matches `PublicProfile` in `@osn/core`.
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
   * Begin WebAuthn login. Pass a handle / email for the identifier-bound
   * flow, or omit to kick off the discoverable-credential (conditional-UI)
   * flow — the response then carries a `challengeId` the caller must pass
   * to `passkeyComplete`.
   */
  passkeyBegin(identifier?: string): Promise<{ options: unknown; challengeId?: string }>;
  /** Complete WebAuthn login — exchange a signed assertion for a session. */
  passkeyComplete(
    input: { identifier: string; assertion: unknown } | { challengeId: string; assertion: unknown },
  ): Promise<LoginResult>;
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
  };
}
