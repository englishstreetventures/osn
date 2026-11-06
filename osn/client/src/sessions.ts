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

import type { AuthFetch } from "./runtime";

export interface SessionsClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
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
  /**
   * True for every session of the caller's device: the family of the session
   * the request's cookie names, while that session is live or was rotated out
   * within the rotation grace window.
   */
  isCurrent: boolean;
}

/**
 * A rejection of `authFetch` reaches the caller unchanged; a failed response
 * becomes a `SessionsError`.
 */
export interface SessionsClient {
  list(): Promise<{ sessions: SessionSummary[] }>;
  revoke(input: { id: string }): Promise<{ revokedSelf: boolean }>;
  revokeAllOther(): Promise<{ success: true }>;
}

// The cookie rides along: it is how the server marks the caller's own sessions.
const INIT: RequestInit = {
  credentials: "include",
  headers: { "Content-Type": "application/json" },
};

export function createSessionsClient(config: SessionsClientConfig): SessionsClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const { authFetch } = config;

  return {
    list: async () => {
      const res = await authFetch(`${base}/sessions`, INIT);
      const json = (await res.json()) as { sessions?: SessionSummary[]; error?: string };
      if (!res.ok || !Array.isArray(json.sessions)) {
        throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
      }
      return { sessions: json.sessions };
    },
    revoke: async (input) => {
      const res = await authFetch(`${base}/sessions/${encodeURIComponent(input.id)}`, {
        ...INIT,
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
    revokeAllOther: async () => {
      const res = await authFetch(`${base}/sessions/revoke-all-other`, {
        ...INIT,
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
