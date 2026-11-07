/**
 * Passkey management client. Drives Settings → Passkeys: list the
 * account's credentials, rename the user-editable label, or delete one.
 * `rename` and `delete` require a fresh step-up token — by default only a
 * passkey step-up, unless the server's config admits more; the caller
 * threads it through from the step-up ceremony.
 */

import { OsnApiError } from "./api-error";
import { reach, readJson, responseError } from "./auth-fetch";

export interface PasskeysClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class PasskeysError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
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

export interface PasskeysClient {
  list(input: { accessToken: string }): Promise<{ passkeys: PasskeySummary[] }>;
  /**
   * Rename a passkey. Step-up gated so an XSS-captured access
   * token cannot reshape labels to mislead the user before a delete.
   */
  rename(input: {
    accessToken: string;
    id: string;
    label: string;
    stepUpToken: string;
  }): Promise<{ success: true }>;
  delete(input: {
    accessToken: string;
    id: string;
    stepUpToken: string;
  }): Promise<{ success: true; remaining: number }>;
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
    accessToken: string;
    profileId: string;
    stepUpToken: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  /** Submit the WebAuthn attestation produced by the browser ceremony. */
  registerComplete(input: {
    accessToken: string;
    profileId: string;
    attestation: unknown;
  }): Promise<{ passkeyId: string }>;
}

function authHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export function createPasskeysClient(config: PasskeysClientConfig): PasskeysClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    list: async (input) => {
      const res = await reach(PasskeysError, `${base}/passkeys`, {
        credentials: "include",
        headers: authHeaders(input.accessToken),
      });
      const json = await readJson<{ passkeys?: PasskeySummary[] }>(PasskeysError, res);
      if (!Array.isArray(json.passkeys)) throw responseError(PasskeysError, res, json);
      return { passkeys: json.passkeys };
    },
    rename: async (input) => {
      const res = await reach(PasskeysError, `${base}/passkeys/${encodeURIComponent(input.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          ...authHeaders(input.accessToken),
          "X-Step-Up-Token": input.stepUpToken,
        },
        body: JSON.stringify({ label: input.label }),
      });
      const json = await readJson<{ success?: boolean }>(PasskeysError, res);
      if (json.success !== true) throw responseError(PasskeysError, res, json);
      return { success: true };
    },
    delete: async (input) => {
      const res = await reach(PasskeysError, `${base}/passkeys/${encodeURIComponent(input.id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          ...authHeaders(input.accessToken),
          "X-Step-Up-Token": input.stepUpToken,
        },
        body: JSON.stringify({}),
      });
      const json = await readJson<{ success?: boolean; remaining?: number }>(PasskeysError, res);
      if (json.success !== true) throw responseError(PasskeysError, res, json);
      return { success: true, remaining: typeof json.remaining === "number" ? json.remaining : 0 };
    },
    registerBegin: async (input) => {
      const res = await reach(PasskeysError, `${base}/passkey/register/begin`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...authHeaders(input.accessToken),
          "X-Step-Up-Token": input.stepUpToken,
        },
        body: JSON.stringify({
          profileId: input.profileId,
          step_up_token: input.stepUpToken,
        }),
      });
      // No shape check on the 2xx body: the options are forwarded
      // exactly as the server sent them, and the browser is the thing that
      // rejects malformed ones.
      return readJson<PublicKeyCredentialCreationOptionsJSON>(PasskeysError, res);
    },
    registerComplete: async (input) => {
      const res = await reach(PasskeysError, `${base}/passkey/register/complete`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(input.accessToken),
        body: JSON.stringify({
          profileId: input.profileId,
          attestation: input.attestation,
        }),
      });
      const json = await readJson<{ passkeyId?: string }>(PasskeysError, res);
      if (typeof json.passkeyId !== "string") throw responseError(PasskeysError, res, json);
      return { passkeyId: json.passkeyId };
    },
  };
}
