/**
 * Plain-fetch client for the social graph API. No Effect — mirrors the
 * pattern in `./login.ts`. Each method calls the OSN core REST API with
 * Bearer token auth.
 */

import { createAuthFetchers } from "./auth-fetch";

export interface GraphClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export interface ConnectionEntry {
  id: string;
  handle: string;
  displayName: string | null;
  connectedAt: string;
}

export interface PendingRequestEntry {
  id: string;
  handle: string;
  displayName: string | null;
  requestedAt: string;
}

export interface SentRequestEntry {
  id: string;
  handle: string;
  displayName: string | null;
  requestedAt: string;
}

export interface ProfileEntry {
  id: string;
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
  listSentRequests(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ sent: SentRequestEntry[] }>;
  listBlocks(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ blocks: ProfileEntry[] }>;
  getConnectionStatus(token: string, handle: string): Promise<ConnectionStatus>;
  sendConnectionRequest(token: string, handle: string): Promise<{ ok: true }>;
  acceptConnection(token: string, handle: string): Promise<{ ok: true }>;
  rejectConnection(token: string, handle: string): Promise<{ ok: true }>;
  removeConnection(token: string, handle: string): Promise<{ ok: true }>;
  blockProfile(token: string, handle: string): Promise<{ ok: true }>;
  unblockProfile(token: string, handle: string): Promise<{ ok: true }>;
}

export function createGraphClient(config: GraphClientConfig): GraphClient {
  const base = `${config.issuerUrl.replace(/\/$/, "")}/graph`;
  // Built here rather than at module scope on purpose. A top-level
  // `createAuthFetchers(...)` is a call a bundler will not drop — a
  // `/* @__PURE__ */` comment does not help, because neither esbuild nor
  // rolldown removes a declarator whose binding is a destructuring pattern.
  // That pinned this module into the entry chunk of every app that imports
  // the barrel. Inside the factory there is no top-level statement left to
  // keep. These deletes return a JSON body; `organisations.ts` uses the
  // void-returning variant instead.
  const { authGet, authPost, authPatch, authDelete } = createAuthFetchers(GraphClientError);

  return {
    listConnections: (token, options) =>
      authGet<{ connections: ConnectionEntry[] }>(`${base}/connections${qs(options)}`, token),

    listPendingRequests: (token, options) =>
      authGet<{ pending: PendingRequestEntry[] }>(
        `${base}/connections/pending${qs(options)}`,
        token,
      ),

    listSentRequests: (token, options) =>
      authGet<{ sent: SentRequestEntry[] }>(`${base}/connections/sent${qs(options)}`, token),

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

    blockProfile: (token, handle) =>
      authPost<{ ok: true }>(`${base}/blocks/${encodeURIComponent(handle)}`, token),

    unblockProfile: (token, handle) =>
      authDelete<{ ok: true }>(`${base}/blocks/${encodeURIComponent(handle)}`, token),
  };
}
