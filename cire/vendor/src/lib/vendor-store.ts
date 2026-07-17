// Data layer for the vendor portal. Pure async helpers over `authFetch`
// (from useAuth()) — no module-level auth state, mirroring how the organiser
// app threads authFetch into its stores. Org create/list hit osn-api
// (/organisations); listing + claim hit cire-api (/api/vendor/*). One OSN
// access token is accepted by both audiences.
import { apiUrl } from "./api";
import { OSN_ISSUER_URL } from "./osn";

type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

// Field names mirror cire-api's ListingDto (directory.ts toDto()).
// NOTE: the real ListingDto includes createdAt and updatedAt as epoch
// milliseconds (number). These are added here to match the server shape.
export interface Listing {
  id: string;
  ownerOrgId: string | null;
  name: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  listed: string;
  categories: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ClaimPreview {
  directoryVendorId: string;
  name: string;
}

export interface ListingInput {
  name: string;
  categories: string[];
  description?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  instagram?: string | null;
  locationText?: string | null;
  priceBand?: string | null;
  priceMinMinor?: number | null;
  priceMaxMinor?: number | null;
}

const ORG_BASE = `${OSN_ISSUER_URL.replace(/\/$/, "")}/organisations`;

/** Read the response as JSON, or null if the body isn't JSON. */
async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

/** Throw a trimmed server error message on non-2xx. */
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await safeJson<{ error?: string }>(res);
  const msg =
    typeof body?.error === "string" && body.error.length > 0
      ? body.error
      : `Request failed: ${res.status}`;
  throw new Error(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
}

export async function listMyOrgs(authFetch: AuthFetch): Promise<OrgSummary[]> {
  const res = await authFetch(ORG_BASE);
  await ensureOk(res);
  const body = await safeJson<{ organisations: OrgSummary[] }>(res);
  return body?.organisations ?? [];
}

// NB: organisation *creation* intentionally has no client here. Orgs are an
// OSN account-level entity created/managed in the OSN app, not the vendor
// portal — the portal only reads the caller's org membership (listMyOrgs).

export async function fetchListing(authFetch: AuthFetch, orgId: string): Promise<Listing | null> {
  const res = await authFetch(apiUrl(`/api/vendor/orgs/${encodeURIComponent(orgId)}/listing`));
  await ensureOk(res);
  const body = await safeJson<{ listing: Listing | null }>(res);
  return body?.listing ?? null;
}

export async function putListing(
  authFetch: AuthFetch,
  orgId: string,
  input: ListingInput,
): Promise<Listing> {
  const res = await authFetch(apiUrl(`/api/vendor/orgs/${encodeURIComponent(orgId)}/listing`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res);
  const body = await safeJson<{ listing: Listing }>(res);
  if (!body?.listing) throw new Error("Invalid response saving listing");
  return body.listing;
}

export async function fetchClaimPreview(token: string): Promise<ClaimPreview | null> {
  const res = await fetch(apiUrl(`/api/vendor/claims/${encodeURIComponent(token)}`));
  if (!res.ok) return null;
  const body = await safeJson<{ listing: ClaimPreview }>(res);
  return body?.listing ?? null;
}

export async function consumeClaim(
  authFetch: AuthFetch,
  token: string,
  orgId: string,
): Promise<Listing> {
  const res = await authFetch(apiUrl(`/api/vendor/claims/${encodeURIComponent(token)}/consume`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
  await ensureOk(res);
  const body = await safeJson<{ listing: Listing }>(res);
  if (!body?.listing) throw new Error("Invalid response consuming claim");
  return body.listing;
}
