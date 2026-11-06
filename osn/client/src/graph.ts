/**
 * Promise client for the social graph API. No Effect — mirrors the pattern in
 * `./login.ts`. Each method calls the OSN core REST API through the page's
 * `authFetch`, which supplies and renews the access token.
 */

import { createAuthFetchers, qs } from "./auth-fetch";
import type { AuthFetch } from "./runtime";

export interface GraphClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
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
// Client interface & factory
// ---------------------------------------------------------------------------

export interface GraphClient {
  listConnections(options?: {
    limit?: number;
    offset?: number;
  }): Promise<{ connections: ConnectionEntry[] }>;
  listPendingRequests(options?: {
    limit?: number;
    offset?: number;
  }): Promise<{ pending: PendingRequestEntry[] }>;
  listSentRequests(options?: {
    limit?: number;
    offset?: number;
  }): Promise<{ sent: SentRequestEntry[] }>;
  listBlocks(options?: { limit?: number; offset?: number }): Promise<{ blocks: ProfileEntry[] }>;
  getConnectionStatus(handle: string): Promise<ConnectionStatus>;
  sendConnectionRequest(handle: string): Promise<{ ok: true }>;
  acceptConnection(handle: string): Promise<{ ok: true }>;
  rejectConnection(handle: string): Promise<{ ok: true }>;
  removeConnection(handle: string): Promise<{ ok: true }>;
  blockProfile(handle: string): Promise<{ ok: true }>;
  unblockProfile(handle: string): Promise<{ ok: true }>;
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
  const { authGet, authPost, authPatch, authDelete } = createAuthFetchers(
    GraphClientError,
    config.authFetch,
  );

  return {
    listConnections: (options) =>
      authGet<{ connections: ConnectionEntry[] }>(`${base}/connections${qs(options)}`),

    listPendingRequests: (options) =>
      authGet<{ pending: PendingRequestEntry[] }>(`${base}/connections/pending${qs(options)}`),

    listSentRequests: (options) =>
      authGet<{ sent: SentRequestEntry[] }>(`${base}/connections/sent${qs(options)}`),

    listBlocks: (options) => authGet<{ blocks: ProfileEntry[] }>(`${base}/blocks${qs(options)}`),

    getConnectionStatus: (handle) =>
      authGet<ConnectionStatus>(`${base}/connections/${encodeURIComponent(handle)}`),

    sendConnectionRequest: (handle) =>
      authPost<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`),

    acceptConnection: (handle) =>
      authPatch<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`, {
        action: "accept",
      }),

    rejectConnection: (handle) =>
      authPatch<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`, {
        action: "reject",
      }),

    removeConnection: (handle) =>
      authDelete<{ ok: true }>(`${base}/connections/${encodeURIComponent(handle)}`),

    blockProfile: (handle) =>
      authPost<{ ok: true }>(`${base}/blocks/${encodeURIComponent(handle)}`),

    unblockProfile: (handle) =>
      authDelete<{ ok: true }>(`${base}/blocks/${encodeURIComponent(handle)}`),
  };
}
