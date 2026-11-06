/**
 * Passkey management client. Drives Settings → Passkeys: list the
 * account's credentials, rename the user-editable label, or delete one.
 * `delete` requires a fresh step-up token (passkey or OTP amr); the
 * caller threads it through from the step-up ceremony.
 */

import type { AuthFetch } from "./runtime";

export interface PasskeysClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

export class PasskeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeysError";
  }
}

export interface PasskeySummary {
  id: string;
  label: string | null;
  aaguid: string | null;
  transports: string[] | null;
  backupEligible: boolean | null;
  backupState: boolean | null;
  /** Unix seconds */
  createdAt: number;
  /** Unix seconds — null if the passkey has never been used for auth. */
  lastUsedAt: number | null;
}

/**
 * A rejection of `authFetch` reaches the caller unchanged; a failed response
 * becomes a `PasskeysError`.
 */
export interface PasskeysClient {
  list(): Promise<{ passkeys: PasskeySummary[] }>;
  /**
   * Rename a passkey. Step-up gated so an XSS-captured access
   * token cannot reshape labels to mislead the user before a delete.
   */
  rename(input: { id: string; label: string; stepUpToken: string }): Promise<{ success: true }>;
  delete(input: { id: string; stepUpToken: string }): Promise<{ success: true; remaining: number }>;
  /**
   * Begin enrolment of an additional passkey for the signed-in account.
   * Hits the same `/passkey/register/begin` endpoint used by first-passkey
   * bootstrap; `stepUpToken` is REQUIRED here because the account
   * already has ≥1 credential — a stolen access token alone must not
   * bind a new authenticator.
   *
   * Returns the server's WebAuthn creation options verbatim — feed them
   * straight to `navigator.credentials.create` (or `startRegistration` from
   * `@simplewebauthn/browser`, which takes the same JSON shape).
   */
  registerBegin(input: {
    profileId: string;
    stepUpToken: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  /** Submit the WebAuthn attestation produced by the browser ceremony. */
  registerComplete(input: {
    profileId: string;
    attestation: unknown;
  }): Promise<{ passkeyId: string }>;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function createPasskeysClient(config: PasskeysClientConfig): PasskeysClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    list: async () => {
      const res = await authFetch(`${base}/passkeys`, {
        credentials: "include",
        headers: JSON_HEADERS,
      });
      const json = (await res.json()) as { passkeys?: PasskeySummary[]; error?: string };
      if (!res.ok || !Array.isArray(json.passkeys)) {
        throw new PasskeysError(json.error ?? `Request failed: ${res.status}`);
      }
      return { passkeys: json.passkeys };
    },
    rename: async (input) => {
      const res = await authFetch(`${base}/passkeys/${encodeURIComponent(input.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          ...JSON_HEADERS,
          "X-Step-Up-Token": input.stepUpToken,
        },
        body: JSON.stringify({ label: input.label }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.success !== true) {
        throw new PasskeysError(json.error ?? `Request failed: ${res.status}`);
      }
      return { success: true };
    },
    delete: async (input) => {
      const res = await authFetch(`${base}/passkeys/${encodeURIComponent(input.id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          ...JSON_HEADERS,
          "X-Step-Up-Token": input.stepUpToken,
        },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        success?: boolean;
        remaining?: number;
        error?: string;
      };
      if (!res.ok || json.success !== true) {
        throw new PasskeysError(json.error ?? `Request failed: ${res.status}`);
      }
      return { success: true, remaining: typeof json.remaining === "number" ? json.remaining : 0 };
    },
    registerBegin: async (input) => {
      const res = await authFetch(`${base}/passkey/register/begin`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...JSON_HEADERS,
          "X-Step-Up-Token": input.stepUpToken,
        },
        body: JSON.stringify({
          profileId: input.profileId,
          step_up_token: input.stepUpToken,
        }),
      });
      // No shape check on the 2xx body — the options are forwarded
      // exactly as the server sent them, and the browser is the thing that
      // rejects malformed ones.
      const json = (await res.json()) as PublicKeyCredentialCreationOptionsJSON & {
        error?: string;
      };
      if (!res.ok) {
        throw new PasskeysError(json.error ?? `Request failed: ${res.status}`);
      }
      return json;
    },
    registerComplete: async (input) => {
      const res = await authFetch(`${base}/passkey/register/complete`, {
        method: "POST",
        credentials: "include",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          profileId: input.profileId,
          attestation: input.attestation,
        }),
      });
      const json = (await res.json()) as { passkeyId?: string; error?: string };
      if (!res.ok || typeof json.passkeyId !== "string") {
        throw new PasskeysError(json.error ?? `Request failed: ${res.status}`);
      }
      return { passkeyId: json.passkeyId };
    },
  };
}
