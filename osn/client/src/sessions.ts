/**
 * Plain-fetch client for session management (list / revoke / revoke-others).
 *
 * Shape mirrors `@osn/client/recovery` — narrow, imperative, no Effect.ts
 * in the public surface. UI components (SessionList) call these directly.
 *
 * Every call requires the caller's short-lived access token (Bearer header)
 * AND sends `credentials: "include"` so the HttpOnly session cookie rides
 * along. The server uses the Bearer for authentication and the cookie to
 * flag `is_current` + distinguish self/other revoke reasons.
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

/**
 * One session row as returned by `GET /sessions`. The `id` is the SHA-256
 * hash of the session token (opaque handle, not a secret) — use it to
 * address a specific session in `revokeSession`.
 */
export interface SessionSummary {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
  deviceLabel: string | null;
  ipHashPrefix: string | null;
  createdIpHashPrefix: string | null;
  isCurrent: boolean;
}

export interface SessionsClient {
  listSessions(input: { accessToken: string }): Promise<{ sessions: SessionSummary[] }>;
  revokeSession(input: {
    accessToken: string;
    sessionId: string;
  }): Promise<{ wasCurrent: boolean }>;
  revokeOtherSessions(input: { accessToken: string }): Promise<{ revoked: number }>;
}

interface SessionWireRow {
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
  device_label: string | null;
  ip_hash_prefix: string | null;
  created_ip_hash_prefix: string | null;
  is_current: boolean;
}

function decodeRow(row: SessionWireRow): SessionSummary {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
    deviceLabel: row.device_label,
    ipHashPrefix: row.ip_hash_prefix,
    createdIpHashPrefix: row.created_ip_hash_prefix,
    isCurrent: row.is_current,
  };
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export function createSessionsClient(config: SessionsClientConfig): SessionsClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const listSessions = async (input: { accessToken: string }) => {
    const res = await fetch(`${base}/sessions`, {
      method: "GET",
      headers: authHeaders(input.accessToken),
      credentials: "include",
    });
    const json = (await res.json()) as { sessions?: SessionWireRow[]; error?: string };
    if (!res.ok || !Array.isArray(json.sessions)) {
      throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
    }
    return { sessions: json.sessions.map(decodeRow) };
  };

  const revokeSession = async (input: { accessToken: string; sessionId: string }) => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(input.sessionId)}`, {
      method: "DELETE",
      headers: authHeaders(input.accessToken),
      credentials: "include",
    });
    const json = (await res.json()) as {
      success?: boolean;
      was_current?: boolean;
      error?: string;
    };
    if (!res.ok || json.success !== true) {
      throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
    }
    return { wasCurrent: json.was_current === true };
  };

  const revokeOtherSessions = async (input: { accessToken: string }) => {
    const res = await fetch(`${base}/sessions/revoke-others`, {
      method: "POST",
      headers: authHeaders(input.accessToken),
      credentials: "include",
      body: "{}",
    });
    const json = (await res.json()) as {
      success?: boolean;
      revoked?: number;
      error?: string;
    };
    if (!res.ok || json.success !== true || typeof json.revoked !== "number") {
      throw new SessionsError(json.error ?? `Request failed: ${res.status}`);
    }
    return { revoked: json.revoked };
  };

  return { listSessions, revokeSession, revokeOtherSessions };
}
