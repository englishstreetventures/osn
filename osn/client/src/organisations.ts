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

export interface OrgSummary {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMember {
  profile: {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  role: "admin" | "member";
  joinedAt: string;
}

export class OrgClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgClientError";
  }
}

// ---------------------------------------------------------------------------
// Client interface & factory
// ---------------------------------------------------------------------------

export interface OrgClient {
  listMyOrgs(
    token: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ organisations: OrgSummary[] }>;
  getOrg(token: string, orgId: string): Promise<OrgSummary>;
  createOrg(
    token: string,
    data: { handle: string; name: string; description?: string },
  ): Promise<OrgSummary>;
  updateOrg(
    token: string,
    orgId: string,
    data: { name?: string; description?: string },
  ): Promise<OrgSummary>;
  deleteOrg(token: string, orgId: string): Promise<void>;
  listMembers(
    token: string,
    orgId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ members: OrgMember[] }>;
  addMember(
    token: string,
    orgId: string,
    profileId: string,
    role: "admin" | "member",
  ): Promise<void>;
  removeMember(token: string, orgId: string, profileId: string): Promise<void>;
  updateMemberRole(
    token: string,
    orgId: string,
    profileId: string,
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

  return {
    listMyOrgs: (token, options) =>
      authGet<{ organisations: OrgSummary[] }>(`${base}${qs(options)}`, token),

    getOrg: (token, orgId) => authGet<OrgSummary>(`${base}/${encodeURIComponent(orgId)}`, token),

    createOrg: (token, data) => authPost<OrgSummary>(base, token, data),

    updateOrg: (token, orgId, data) =>
      authPatch<OrgSummary>(`${base}/${encodeURIComponent(orgId)}`, token, data),

    deleteOrg: (token, orgId) => authDelete(`${base}/${encodeURIComponent(orgId)}`, token),

    listMembers: (token, orgId, options) =>
      authGet<{ members: OrgMember[] }>(
        `${base}/${encodeURIComponent(orgId)}/members${qs(options)}`,
        token,
      ),

    addMember: (token, orgId, profileId, role) =>
      authPost(`${base}/${encodeURIComponent(orgId)}/members`, token, { profileId, role }).then(
        () => undefined,
      ),

    removeMember: (token, orgId, profileId) =>
      authDelete(
        `${base}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(profileId)}`,
        token,
      ),

    updateMemberRole: (token, orgId, profileId, role) =>
      authPatch(
        `${base}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(profileId)}`,
        token,
        { role },
      ).then(() => undefined),
  };
}
