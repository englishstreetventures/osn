/**
 * Session introspection + revocation client.
 *
 * Drives the Settings → Sessions panel: list the account's active
 * sessions, revoke a specific device, or sign out everywhere else.
 *
 * Revocation uses the server's public "session handle" (16 hex chars),
 * never a full SHA-256 hash — that way a log capture can't be weaponised
 * to forge a DELETE.
 */

export interface SessionsClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class SessionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionsError";
  }
}

export interface SessionSummary {
  id: string;
  uaLabel: string | null;
  /** Unix seconds */
  createdAt: number;
  /** Unix seconds — null for sessions that haven't been touched since creation. */
  lastUsedAt: number | null;
  /** Unix seconds */
  expiresAt: number;
  /** True when this is the caller's current session (cookie-match). */
  isCurrent: boolean;
}

export interface SessionsClient {
  list(input: { accessToken: string }): Promise<{ sessions: SessionSummary[] }>;
  revoke(input: { accessToken: string; id: string }): Promise<{ revokedSelf: boolean }>;
  revokeAllOther(input: { accessToken: string }): Promise<{ success: true }>;
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

export function createSessionsClient(config: SessionsClientConfig): SessionsClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  return {
    list: async (input) => {
      const res = await fetch(`${base}/sessions`, { ...withAuth(input.accessToken) });
      const json = (await res.json()) as { sessions?: SessionSummary[]; error?: string };
      if (!res.ok || !Array.isArray(json.sessions)) {
        throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { sessions: json.sessions };
    },
    revoke: async (input) => {
      const res = await fetch(`${base}/sessions/${encodeURIComponent(input.id)}`, {
        ...withAuth(input.accessToken),
        method: "DELETE",
      });
      const json = (await res.json()) as {
        success?: boolean;
        revokedSelf?: boolean;
        error?: string;
      };
      if (!res.ok || json.success !== true) {
        throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { revokedSelf: json.revokedSelf === true };
    },
    revokeAllOther: async (input) => {
      const res = await fetch(`${base}/sessions/revoke-all-other`, {
        ...withAuth(input.accessToken),
        method: "POST",
        body: "{}",
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.success !== true) {
        throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { success: true };
    },
  };
}
