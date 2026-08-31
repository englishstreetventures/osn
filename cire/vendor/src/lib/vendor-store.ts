// Data layer for the vendor portal. Pure async helpers over `authFetch`
// (from useAuth()) — no module-level auth state, mirroring how the organiser
// app threads authFetch into its stores. EVERY call goes to cire-api: the
// portal holds a cire session cookie, not an OSN token, so it cannot read
// osn-api directly. The caller's organisations come from cire-api's
// `GET /api/vendor/orgs`, which proxies osn-api over ARC.
import { apiUrl } from "./api";

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
  const res = await authFetch(apiUrl("/api/vendor/orgs"));
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

// ── Claim → editor handoff (VP-P-W2) ────────────────────────────────────────
// `consumeClaim` already returns the listing, but the claim page redirects
// with a full document navigation (`window.location.href`), which drops
// everything in memory. sessionStorage crosses that gap the same way
// CLAIM_TOKEN_KEY crosses the sign-in redirect in ClaimApp. The key is read
// once: `takeSeededListing` deletes it on the way out, whether or not the
// value turns out usable, so it can never leak into a later, unrelated load.
const CLAIMED_LISTING_KEY = "cire.vendor.claimed-listing";

interface ClaimedListingSeed {
  orgId: string;
  listing: Listing;
}

/**
 * The fields {@link isValidListing} reads, each still `unknown` because the
 * value came out of a JSON.parse of a sessionStorage string, not the network —
 * same idiom as `CropCandidate` in `cire/api/src/schemas/invite.ts`.
 *
 * These are every field {@link Listing} declares as required and non-nullable.
 * The nullable ones are deliberately left unchecked: `null` and absent are the
 * same thing to every reader of them, so a seed missing one behaves exactly
 * like a listing that never had it. The required ones are not so forgiving —
 * `ListingEditor` renders `listed` straight into the status chip, so a seed
 * without it puts the word "undefined" on screen (S-L1).
 */
interface ListingCandidate {
  id?: unknown;
  name?: unknown;
  listed?: unknown;
  categories?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function isListingCandidate(value: unknown): value is ListingCandidate {
  return typeof value === "object" && value !== null;
}

function isValidListing(value: unknown): value is Listing {
  if (!isListingCandidate(value)) return false;
  const { id, name, listed, categories, createdAt, updatedAt } = value;
  return (
    typeof id === "string" &&
    typeof name === "string" &&
    typeof listed === "string" &&
    Array.isArray(categories) &&
    categories.every((entry) => typeof entry === "string") &&
    typeof createdAt === "number" &&
    typeof updatedAt === "number"
  );
}

/**
 * Stash the listing `consumeClaim` just returned, keyed to the org it
 * belongs to, so the editor can seed from it instead of re-fetching.
 * Best-effort: sessionStorage can throw (private mode, blocked site data);
 * a failure here just means the editor falls back to its normal fetch.
 */
export function seedClaimedListing(orgId: string, listing: Listing): void {
  try {
    sessionStorage.setItem(CLAIMED_LISTING_KEY, JSON.stringify({ orgId, listing }));
  } catch {
    // No seed, no problem.
  }
}

/**
 * Take the listing seeded by a just-completed claim, if any, for `orgId`.
 * Returns `undefined` on every failure mode — key absent, unparseable JSON,
 * a mismatched org, a shape that doesn't look like `Listing`, or
 * sessionStorage throwing on read — so the caller always has a clean
 * fall-through to fetchListing.
 */
export function takeSeededListing(orgId: string): Listing | undefined {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(CLAIMED_LISTING_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    sessionStorage.removeItem(CLAIMED_LISTING_KEY);
  } catch {
    // Read succeeded but removal failed — proceed anyway; a stale key left
    // behind gets rejected below on org mismatch or bad shape at worst.
  }
  try {
    const seed = JSON.parse(raw) as ClaimedListingSeed;
    if (seed.orgId !== orgId) return undefined;
    if (!isValidListing(seed.listing)) return undefined;
    return seed.listing;
  } catch {
    return undefined;
  }
}
