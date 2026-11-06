/**
 * OIDC connections client — the apps this account has authorised through the
 * OSN OpenID Connect provider.
 *
 * Drives Settings → Connected apps: list the third-party (and first-party)
 * relying parties the user has consented to, and revoke one. Revoking marks
 * the consent row and kills any authorization code in flight for the pair, so
 * the app's next sign-in gets `consent_required` (Art. 7(3): revoking must be
 * as easy as granting).
 *
 * Access-token authed like every other settings surface.
 */

import type { AuthFetch } from "./runtime";

export interface ConnectionsClientConfig {
  /** OSN issuer base URL, e.g. https://id.musubi.social */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

export class ConnectionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionsError";
  }
}

export interface OidcConnection {
  clientId: string;
  /** Null only if the client row was deleted out from under the consent. */
  clientName: string | null;
  logoUrl: string | null;
  profileId: string;
  /** Space-separated granted scopes. */
  scope: string;
  /** Unix seconds. */
  grantedAt: number;
}

/**
 * A rejection of `authFetch` reaches the caller unchanged; a failed response
 * becomes a `ConnectionsError`.
 */
export interface ConnectionsClient {
  list(): Promise<{ connections: OidcConnection[] }>;
  revoke(input: { clientId: string }): Promise<{ success: true }>;
}

const INIT: RequestInit = {
  credentials: "include",
  headers: { "Content-Type": "application/json" },
};

export function createConnectionsClient(config: ConnectionsClientConfig): ConnectionsClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    list: async () => {
      const res = await authFetch(`${base}/oidc/connections`, INIT);
      const json = (await res.json()) as { connections?: OidcConnection[]; error?: string };
      if (!res.ok || !Array.isArray(json.connections)) {
        throw new ConnectionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { connections: json.connections };
    },
    revoke: async (input) => {
      const res = await authFetch(
        `${base}/oidc/connections/${encodeURIComponent(input.clientId)}`,
        {
          ...INIT,
          method: "DELETE",
        },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.success !== true) {
        throw new ConnectionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { success: true };
    },
  };
}
