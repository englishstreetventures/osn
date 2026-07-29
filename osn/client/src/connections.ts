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

export interface ConnectionsClientConfig {
  /** OSN issuer base URL, e.g. https://id.musubi.social */
  issuerUrl: string;
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

export interface ConnectionsClient {
  list(input: { accessToken: string }): Promise<{ connections: OidcConnection[] }>;
  revoke(input: { accessToken: string; clientId: string }): Promise<{ success: true }>;
}

function withAuth(accessToken: string): RequestInit {
  return {
    credentials: "include",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };
}

export function createConnectionsClient(config: ConnectionsClientConfig): ConnectionsClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    list: async (input) => {
      const res = await fetch(`${base}/oidc/connections`, { ...withAuth(input.accessToken) });
      const json = (await res.json()) as { connections?: OidcConnection[]; error?: string };
      if (!res.ok || !Array.isArray(json.connections)) {
        throw new ConnectionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { connections: json.connections };
    },
    revoke: async (input) => {
      const res = await fetch(`${base}/oidc/connections/${encodeURIComponent(input.clientId)}`, {
        ...withAuth(input.accessToken),
        method: "DELETE",
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.success !== true) {
        throw new ConnectionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { success: true };
    },
  };
}
