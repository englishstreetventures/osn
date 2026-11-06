/**
 * Plain-fetch client for the organisations API. No Effect — mirrors the
 * pattern in `./login.ts`. Each method calls the OSN core REST API with
 * Bearer token auth.
 */

import { createAuthFetchers, qs } from "./auth-fetch";

export interface OrgClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
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
  listMyOrgs(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ organisations: OrgSummary[] }>;
  getOrg(token: string, handle: string): Promise<{ organisation: OrgSummary }>;
  createOrg(
    token: string,
    data: { handle: string; name: string; description?: string },
  ): Promise<{ ok: boolean; organisation: OrgSummary }>;
  updateOrg(
    token: string,
    handle: string,
    data: { name?: string; description?: string },
  ): Promise<{ ok: boolean; organisation: OrgSummary }>;
  deleteOrg(token: string, handle: string): Promise<void>;
  listMembers(
    token: string,
    handle: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ members: OrgMember[] }>;
  addMember(
    token: string,
    handle: string,
    profileHandle: string,
    role: "admin" | "member",
  ): Promise<void>;
  removeMember(token: string, handle: string, profileHandle: string): Promise<void>;
  updateMemberRole(
    token: string,
    handle: string,
    profileHandle: string,
    role: "admin" | "member",
  ): Promise<void>;
}

export function createOrgClient(config: OrgClientConfig): OrgClient {
  const base = `${config.issuerUrl.replace(/\/$/, "")}/organisations`;
  // Built here, not at module scope: a top-level `createAuthFetchers(...)` is
  // a call no bundler will drop, which pinned this module into the entry
  // chunk of every app importing the barrel. `/* @__PURE__ */` does not fix
  // that on a destructuring declarator.
  const { authGet, authPost, authPatch, authDeleteVoid } = createAuthFetchers(OrgClientError);
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
    listMyOrgs: (token, options) =>
      authGet<{ organisations: OrgSummary[] }>(`${base}${qs(options)}`, token),

    getOrg: (token, handle) => authGet<{ organisation: OrgSummary }>(org(handle), token),

    createOrg: (token, data) =>
      authPost<{ ok: boolean; organisation: OrgSummary }>(base, token, data),

    updateOrg: (token, handle, data) =>
      authPatch<{ ok: boolean; organisation: OrgSummary }>(org(handle), token, data),

    deleteOrg: (token, handle) => authDelete(org(handle), token),

    listMembers: (token, handle, options) =>
      authGet<{ members: OrgMember[] }>(`${org(handle)}/members${qs(options)}`, token),

    addMember: (token, handle, profileHandle, role) =>
      authPost(member(handle, profileHandle), token, { role }).then(() => undefined),

    removeMember: (token, handle, profileHandle) =>
      authDelete(member(handle, profileHandle), token),

    updateMemberRole: (token, handle, profileHandle, role) =>
      authPatch(member(handle, profileHandle), token, { role }).then(() => undefined),
  };
}
