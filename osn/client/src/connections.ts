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

import { OsnApiError } from "./api-error";
import { reach, readJson, responseError } from "./auth-fetch";

export interface ConnectionsClientConfig {
  /** OSN issuer base URL, e.g. https://id.musubi.social */
  issuerUrl: string;
}

export class ConnectionsError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
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
      const res = await reach(ConnectionsError, `${base}/oidc/connections`, {
        ...withAuth(input.accessToken),
      });
      const json = await readJson<{ connections?: OidcConnection[] }>(ConnectionsError, res);
      if (!Array.isArray(json.connections)) throw responseError(ConnectionsError, res, json);
      return { connections: json.connections };
    },
    revoke: async (input) => {
      const res = await reach(
        ConnectionsError,
        `${base}/oidc/connections/${encodeURIComponent(input.clientId)}`,
        { ...withAuth(input.accessToken), method: "DELETE" },
      );
      const json = await readJson<{ success?: boolean }>(ConnectionsError, res);
      if (json.success !== true) throw responseError(ConnectionsError, res, json);
      return { success: true };
    },
  };
}
