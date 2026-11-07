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

import { OsnApiError } from "./api-error";
import { reach, readJson, responseError } from "./auth-fetch";

export interface SessionsClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class SessionsError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
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
      const res = await reach(SessionsError, `${base}/sessions`, {
        ...withAuth(input.accessToken),
      });
      const json = await readJson<{ sessions?: SessionSummary[] }>(SessionsError, res);
      if (!Array.isArray(json.sessions)) throw responseError(SessionsError, res, json);
      return { sessions: json.sessions };
    },
    revoke: async (input) => {
      const res = await reach(SessionsError, `${base}/sessions/${encodeURIComponent(input.id)}`, {
        ...withAuth(input.accessToken),
        method: "DELETE",
      });
      const json = await readJson<{ success?: boolean; revokedSelf?: boolean }>(SessionsError, res);
      if (json.success !== true) throw responseError(SessionsError, res, json);
      return { revokedSelf: json.revokedSelf === true };
    },
    revokeAllOther: async (input) => {
      const res = await reach(SessionsError, `${base}/sessions/revoke-all-other`, {
        ...withAuth(input.accessToken),
        method: "POST",
        body: "{}",
      });
      const json = await readJson<{ success?: boolean }>(SessionsError, res);
      if (json.success !== true) throw responseError(SessionsError, res, json);
      return { success: true };
    },
  };
}
