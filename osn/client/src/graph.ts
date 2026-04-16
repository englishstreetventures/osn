/**
 * Plain-fetch client for the social graph API. No Effect — mirrors the
 * pattern in `./login.ts`. Each method calls the OSN core REST API with
 * Bearer token auth.
 */

export interface GraphClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export interface ConnectionEntry {
  handle: string;
  displayName: string | null;
  connectedAt: string;
}

export interface PendingRequestEntry {
  handle: string;
  displayName: string | null;
  requestedAt: string;
}

export interface ProfileEntry {
  handle: string;
  displayName: string | null;
}

export interface ConnectionStatus {
  status: "none" | "pending_outgoing" | "pending_incoming" | "connected";
}

export class GraphClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphClientError";
  }
}

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

/**
 * Parse response body as JSON, returning null if the body isn't JSON.
 * Prevents SyntaxError from surfacing to UI toasts (S-L2).
 */
async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

/** Cap server-supplied error strings before surfacing to the UI (S-L2). */
function safeErrorMessage(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length === 0) return `Request failed: ${status}`;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

async function authGet<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await safeJson<T>(res);
  if (!res.ok) {
    throw new GraphClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new GraphClientError(`Invalid response: ${res.status}`);
  }
  return json;
}

async function authPost<T>(url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await safeJson<T>(res);
  if (!res.ok) {
    throw new GraphClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new GraphClientError(`Invalid response: ${res.status}`);
  }
  return json;
}

async function authPatch<T>(url: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await safeJson<T>(res);
  if (!res.ok) {
    throw new GraphClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new GraphClientError(`Invalid response: ${res.status}`);
  }
  return json;
}

async function authDelete<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await safeJson<T>(res);
  if (!res.ok) {
    throw new GraphClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new GraphClientError(`Invalid response: ${res.status}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Query string helper
// ---------------------------------------------------------------------------

function qs(options?: { limit?: number; offset?: number }): string {
  if (!options) return "";
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const str = params.toString();
  return str ? `?${str}` : "";
}

// ---------------------------------------------------------------------------
// Client interface & factory
// ---------------------------------------------------------------------------

export interface GraphClient {
  listConnections(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ connections: ConnectionEntry[] }>;
  listPendingRequests(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ pending: PendingRequestEntry[] }>;
  listCloseFriends(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ closeFriends: ProfileEntry[] }>;
  listBlocks(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ blocks: ProfileEntry[] }>;
  getConnectionStatus(token: string, handle: string): Promise<ConnectionStatus>;
  sendConnectionRequest(token: string, handle: string): Promise<{ ok: true }>;
  acceptConnection(token: string, handle: string): Promise<{ ok: true }>;
  rejectConnection(token: string, handle: string): Promise<{ ok: true }>;
  removeConnection(token: string, handle: string): Promise<{ ok: true }>;
  addCloseFriend(token: string, handle: string): Promise<{ ok: true }>;
  removeCloseFriend(token: string, handle: string): Promise<{ ok: true }>;
  blockProfile(token: string, handle: string): Promise<{ ok: true }>;
  unblockProfile(token: string, handle: string): Promise<{ ok: true }>;
}

export function createGraphClient(config: GraphClientConfig): GraphClient {
  const base = `${config.issuerUrl.replace(/\/$/, "")}/graph`;

  return {
    listConnections: (token, options) =>
      authGet<{ connections: ConnectionEntry[] }>(`${base}/connections${qs(options)}`, token),

    listPendingRequests: (token, options) =>
      authGet<{ pending: PendingRequestEntry[] }>(
        `${base}/connections/pending${qs(options)}`,
        token,
      ),

    listCloseFriends: (token, options) =>
      authGet<{ closeFriends: ProfileEntry[] }>(`${base}/close-friends${qs(options)}`, token),

    listBlocks: (token, options) =>
      authGet<{ blocks: ProfileEntry[] }>(`${base}/blocks${qs(options)}`, token),

    getConnectionStatus: (token, handle) =>
      authGet<ConnectionStatus>(`${base}/connections/${encodeURIComponent(handle)}`, token),

    sendConnectionRequest: (token, handle) =>
      authPost<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`, token),

    acceptConnection: (token, handle) =>
      authPatch<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`, token, {
        action: "accept",
      }),

    rejectConnection: (token, handle) =>
      authPatch<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`, token, {
        action: "reject",
      }),

    removeConnection: (token, handle) =>
      authDelete<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`, token),

    addCloseFriend: (token, handle) =>
      authPost<{ ok: true }>(`${base}/close-friends/${encodeURIComponent(handle)}`, token),

    removeCloseFriend: (token, handle) =>
      authDelete<{ ok: true }>(`${base}/close-friends/${encodeURIComponent(handle)}`, token),

    blockProfile: (token, handle) =>
      authPost<{ ok: true }>(`${base}/blocks/${encodeURIComponent(handle)}`, token),

    unblockProfile: (token, handle) =>
      authDelete<{ ok: true }>(`${base}/blocks/${encodeURIComponent(handle)}`, token),
  };
}
