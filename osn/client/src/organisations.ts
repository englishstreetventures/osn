/**
 * Plain-fetch client for the organisations API. No Effect — mirrors the
 * pattern in `./login.ts`. Each method calls the OSN core REST API with
 * Bearer token auth.
 */

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
// Internal fetch helpers
// ---------------------------------------------------------------------------

/** Parse response body as JSON, returning null if the body isn't JSON (S-L2). */
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
    throw new OrgClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new OrgClientError(`Invalid response: ${res.status}`);
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
    throw new OrgClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new OrgClientError(`Invalid response: ${res.status}`);
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
    throw new OrgClientError(safeErrorMessage(json?.error, res.status));
  }
  if (json === null) {
    throw new OrgClientError(`Invalid response: ${res.status}`);
  }
  return json;
}

async function authDelete(url: string, token: string): Promise<void> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const json = await safeJson<Record<string, unknown>>(res);
    throw new OrgClientError(safeErrorMessage(json?.error, res.status));
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
