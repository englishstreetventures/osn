// Coming back from Stripe.
//
// The receipt rides in the QUERY (`?upgrade=<id>&w=<weddingId>&m=<module>`),
// never the fragment: the portal is hash-routed, so the hash is the route, and
// nothing in this product asks Stripe to preserve a fragment.
//
// NOTHING HERE GRANTS ANYTHING. A purchase becomes an entitlement when the
// signature-verified webhook says so; this only asks what happened. A
// hand-typed `?upgrade=` therefore buys nobody anything — at worst it polls a
// purchase that is not theirs and is told 404.
import { isModule, type Module } from "./dashboard-route";

export interface UpgradeReturn {
  purchaseId: string;
  weddingId: string;
  /** Where to land once it settles. Absent when the param was not a module. */
  module: Module | null;
}

/**
 * Read the receipt out of a URL's query, or `null` when there isn't one.
 *
 * `m` is validated against the real module list rather than trusted: it decides
 * a route, and an unknown value would otherwise put the shell into a state its
 * parser cannot produce.
 */
export function readUpgradeReturn(search: string): UpgradeReturn | null {
  const params = new URLSearchParams(search);
  const purchaseId = params.get("upgrade");
  const weddingId = params.get("w");
  if (!purchaseId || !weddingId) return null;
  const rawModule = params.get("m");
  return {
    purchaseId,
    weddingId,
    module: rawModule && isModule(rawModule) ? rawModule : null,
  };
}

/**
 * Strip the receipt params, keeping everything else.
 *
 * Required, not tidiness: `OrganiserApp` rebuilds the URL as
 * `pathname + search + hash` on EVERY hash write, and the login bounce carries
 * `search` through too — so an unstripped `?upgrade=` survives every later
 * navigation, refresh and bookmark, and the handler re-polls and re-toasts each
 * time.
 */
export function clearUpgradeParams(url: URL): string {
  const next = new URL(url.href);
  for (const key of ["upgrade", "w", "m"]) next.searchParams.delete(key);
  return `${next.pathname}${next.search}${next.hash}`;
}

/** How long to keep asking before giving up on a webhook that has not landed. */
export const POLL_ATTEMPTS = 8;
/**
 * Gap between polls, growing.
 *
 * Stripe's delivery is usually inside a second, so the first few are quick;
 * after that the honest thing is to slow down rather than hammer an endpoint
 * that is waiting on somebody else's queue.
 */
export function pollDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}
