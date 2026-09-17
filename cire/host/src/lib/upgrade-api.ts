// The upgrade endpoints, as the portal calls them.
//
// `authFetch` is a PARAMETER, never an import: every cire/api call goes through
// `useAuth().authFetch` so the session cookie rides along, and that lives in the
// AuthProvider context rather than in a module singleton (see `api.ts`).
//
// NOTHING HERE GRANTS ANYTHING. `startUpgrade` returns a payment page; only a
// signature-verified Stripe webhook can grant an entitlement. That is why the
// return from Stripe polls `fetchPurchase` instead of assuming success.
import { apiUrl } from "./api";

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

const base = (weddingId: string) =>
  `/api/organiser/weddings/${encodeURIComponent(weddingId)}/upgrade`;

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

/** One sellable upgrade, priced, and whether this wedding already has it. */
export interface CatalogueEntry {
  entitlement: string;
  title: string;
  blurb: string;
  amountMinor: number;
  currency: string;
  held: boolean;
}

export interface PurchaseState {
  status: "pending" | "succeeded" | "failed" | "expired";
  entitlement: string;
}

/**
 * What this wedding can buy.
 *
 * A 404 means the deployment has no Stripe configured at all, so the routes are
 * not mounted — an empty catalogue rather than an error, because the portal's
 * honest answer there is "no purchase path", not "something broke".
 */
export async function fetchCatalogue(
  authFetch: AuthFetch,
  weddingId: string,
): Promise<CatalogueEntry[]> {
  const res = await authFetch(apiUrl(`${base(weddingId)}/catalogue`));
  if (res.status === 404) return [];
  await ensureOk(res);
  const body = (await res.json()) as { upgrades?: CatalogueEntry[] };
  return body.upgrades ?? [];
}

/** Start a purchase. Resolves to the Stripe page to send the organiser to. */
export async function startUpgrade(
  authFetch: AuthFetch,
  weddingId: string,
  entitlement: string,
): Promise<{ purchaseId: string; url: string; reused: boolean }> {
  const res = await authFetch(apiUrl(`${base(weddingId)}/session`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entitlement }),
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
  const body = (await res.json()) as { purchase: PurchaseState };
  return body.purchase;
}
