/**
 * Promise client for the organisations API. No Effect — mirrors the pattern
 * in `./login.ts`. Each method calls the OSN core REST API through the page's
 * `authFetch`, which supplies and renews the access token.
 */

import { createAuthFetchers, qs } from "./auth-fetch";
import type { AuthFetch } from "./runtime";

export interface OrgClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /** The page runtime's `authFetch` (`createOsnAuthRuntime`). */
  authFetch: AuthFetch;
}

/**
 * An organisation as every organisation route answers with it. No id: the
 * routes address an organisation by its handle.
 */
export interface OrgSummary {
  handle: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of an organisation's roster. No profile id and no avatar: the routes
 * address a member by handle, and the roster carries nothing more.
 */
export interface OrgMember {
  handle: string;
  displayName: string | null;
  role: "admin" | "member";
  joinedAt: string;
}

export class OrgClientError extends Error {
  /** The HTTP status of the response that failed. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OrgClientError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Client interface & factory
// ---------------------------------------------------------------------------

/**
 * Each method returns its route's success body as sent. An organisation is
 * addressed by its `handle`, a member by their profile's `profileHandle`.
 */
export interface OrgClient {
  listMyOrgs(options?: {
    limit?: number;
    offset?: number;
  }): Promise<{ organisations: OrgSummary[] }>;
  getOrg(handle: string): Promise<{ organisation: OrgSummary }>;
  createOrg(data: {
    handle: string;
    name: string;
    description?: string;
  }): Promise<{ ok: boolean; organisation: OrgSummary }>;
  updateOrg(
    handle: string,
    data: { name?: string; description?: string },
  ): Promise<{ ok: boolean; organisation: OrgSummary }>;
  deleteOrg(handle: string): Promise<void>;
  listMembers(
    handle: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ members: OrgMember[] }>;
  addMember(handle: string, profileHandle: string, role: "admin" | "member"): Promise<void>;
  removeMember(handle: string, profileHandle: string): Promise<void>;
  updateMemberRole(handle: string, profileHandle: string, role: "admin" | "member"): Promise<void>;
}

export function createOrgClient(config: OrgClientConfig): OrgClient {
  const base = `${config.issuerUrl.replace(/\/$/, "")}/organisations`;
  // Built here, not at module scope: a top-level `createAuthFetchers(...)` is
  // a call no bundler will drop, which pinned this module into the entry
  // chunk of every app importing the barrel. `/* @__PURE__ */` does not fix
  // that on a destructuring declarator.
  const { authGet, authPost, authPatch, authDeleteVoid } = createAuthFetchers(
    OrgClientError,
    config.authFetch,
  );
  // `deleteOrg` and `removeMember` are declared `Promise<void>` on `OrgClient`
  // and their callers use no body, so this module discards it. The routes do
  // return `{ ok: true }` (see `osn/api/src/routes/organisation.ts`) — the
  // void variant simply never reads it, which also means a success response
  // that does not parse cannot throw.
  const authDelete = authDeleteVoid;

  const org = (handle: string) => `${base}/${encodeURIComponent(handle)}`;
  const member = (handle: string, profileHandle: string) =>
    `${org(handle)}/members/${encodeURIComponent(profileHandle)}`;

  return {
    listMyOrgs: (options) => authGet<{ organisations: OrgSummary[] }>(`${base}${qs(options)}`),

    getOrg: (handle) => authGet<{ organisation: OrgSummary }>(org(handle)),

    createOrg: (data) => authPost<{ ok: boolean; organisation: OrgSummary }>(base, data),

    updateOrg: (handle, data) =>
      authPatch<{ ok: boolean; organisation: OrgSummary }>(org(handle), data),

    deleteOrg: (handle) => authDelete(org(handle)),

    listMembers: (handle, options) =>
      authGet<{ members: OrgMember[] }>(`${org(handle)}/members${qs(options)}`),

    addMember: (handle, profileHandle, role) =>
      authPost(member(handle, profileHandle), { role }).then(() => undefined),

    removeMember: (handle, profileHandle) => authDelete(member(handle, profileHandle)),

    updateMemberRole: (handle, profileHandle, role) =>
      authPatch(member(handle, profileHandle), { role }).then(() => undefined),
  };
}
