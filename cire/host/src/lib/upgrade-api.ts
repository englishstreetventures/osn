// The upgrade endpoints, as the portal calls them.
//
// `authFetch` is a PARAMETER, never an import: every cire/api call goes through
// `useAuth().authFetch` so the session cookie rides along, and that lives in the
// AuthProvider context rather than in a module singleton (see `api.ts`).
//
// NOTHING HERE GRANTS ANYTHING. `startUpgrade` returns a payment page; only a
// signature-verified Stripe webhook can raise a wedding's tier. That is why the
// return from Stripe polls `fetchPurchase` instead of assuming success.
import { apiUrl, weddingPath } from "./api";
import type { Module } from "./dashboard-route";
import { isPaidTier, isTier, type PaidTier, type Tier } from "./tiers";

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

const base = (weddingId: string) => weddingPath(weddingId, "/upgrade");

export class UpgradeApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
    this.name = "UpgradeApiError";
  }
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new UpgradeApiError(body?.error ?? `http_${res.status}`, res.status);
}

/** One tier this wedding can move up to, priced for the move from the tier it
 *  is on now. */
export interface CatalogueEntry {
  tier: PaidTier;
  /** The wedding's tier the price is quoted from. A wedding on Gold buying
   *  Crimson pays the upgrade-from-Gold price, not Crimson's full price. */
  fromTier: Tier;
  title: string;
  blurb: string;
  amountMinor: number;
  currency: string;
}

/** What a wedding can buy, and the tier it is on now. */
export interface Catalogue {
  /** The wedding's tier, from the same row the API gates on. `null` when the
   *  deployment sells nothing, so there was no catalogue to read it from. */
  tier: Tier | null;
  /** Only tiers above `tier`, lowest first. Empty when nothing is for sale. */
  upgrades: CatalogueEntry[];
}

export interface PurchaseState {
  status: "pending" | "succeeded" | "failed" | "expired";
  /** The tier the purchase buys. `null` for a purchase that names no tier this
   *  build knows. */
  tier: PaidTier | null;
}

/** The catalogue answer when the deployment sells nothing. */
const NOTHING_FOR_SALE: Catalogue = { tier: null, upgrades: [] };

/**
 * What this wedding can buy.
 *
 * A 404 means the deployment has no Stripe configured at all, so the routes are
 * not mounted — an empty catalogue rather than an error, because the portal's
 * honest answer there is "no purchase path", not "something broke".
 *
 * An entry for a tier this build does not know is dropped: the dialog offers a
 * tier by name, and one it cannot name is not one it can sell.
 */
export async function fetchCatalogue(authFetch: AuthFetch, weddingId: string): Promise<Catalogue> {
  const res = await authFetch(apiUrl(`${base(weddingId)}/catalogue`));
  if (res.status === 404) return NOTHING_FOR_SALE;
  await ensureOk(res);
  const body = (await res.json()) as { tier?: unknown; upgrades?: CatalogueEntry[] };
  return {
    tier: isTier(body.tier) ? body.tier : null,
    upgrades: (body.upgrades ?? []).filter((entry) => isPaidTier(entry.tier)),
  };
}

/**
 * Start a purchase. Resolves to the Stripe page to send the organiser to.
 *
 * `module` is where Stripe sends the organiser back to; the API checks it
 * against the portal's module list and lands anything else on Overview.
 */
export async function startUpgrade(
  authFetch: AuthFetch,
  weddingId: string,
  tier: PaidTier,
  module?: Module,
): Promise<{ purchaseId: string; url: string; reused: boolean }> {
  const res = await authFetch(apiUrl(`${base(weddingId)}/session`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(module === undefined ? { tier } : { tier, module }),
  });
  await ensureOk(res);
  return (await res.json()) as { purchaseId: string; url: string; reused: boolean };
}

/** Where a purchase has got to. `null` when this wedding has no such purchase. */
export async function fetchPurchase(
  authFetch: AuthFetch,
  weddingId: string,
  purchaseId: string,
): Promise<PurchaseState | null> {
  const res = await authFetch(
    apiUrl(`${base(weddingId)}/purchases/${encodeURIComponent(purchaseId)}`),
  );
  if (res.status === 404) return null;
  await ensureOk(res);
  const body = (await res.json()) as {
    purchase: { status: PurchaseState["status"]; tier?: unknown };
  };
  return {
    status: body.purchase.status,
    tier: isPaidTier(body.purchase.tier) ? body.purchase.tier : null,
  };
}
