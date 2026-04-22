/**
 * Passkey management client. Drives Settings → Passkeys: list the
 * account's credentials, rename the user-editable label, or delete one.
 * `delete` requires a fresh step-up token (passkey or OTP amr); the
 * caller threads it through from the step-up ceremony.
 */

export interface PasskeysClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
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

export interface PasskeysClient {
  list(input: { accessToken: string }): Promise<{ passkeys: PasskeySummary[] }>;
  /**
   * Rename a passkey. Step-up gated (S-M2) so an XSS-captured access
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
}

export function createPasskeysClient(config: PasskeysClientConfig): PasskeysClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const authHeaders = (accessToken: string): HeadersInit => ({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  });

  return {
    list: async (input) => {
      const res = await fetch(`${base}/passkeys`, {
        credentials: "include",
        headers: authHeaders(input.accessToken),
      });
      const json = (await res.json()) as { passkeys?: PasskeySummary[]; error?: string };
      if (!res.ok || !Array.isArray(json.passkeys)) {
        throw new PasskeysError(json.error ?? `Request failed: ${res.status}`);
      }
      return { passkeys: json.passkeys };
    },
    rename: async (input) => {
      const res = await fetch(`${base}/passkeys/${encodeURIComponent(input.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          ...authHeaders(input.accessToken),
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
      const res = await fetch(`${base}/passkeys/${encodeURIComponent(input.id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          ...authHeaders(input.accessToken),
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
  };
}
