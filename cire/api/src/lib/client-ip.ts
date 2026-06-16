/**
 * Resolve the caller's IP for rate-limit keying (C4).
 *
 * cire/api runs exclusively behind Cloudflare, so the ONLY trustworthy client
 * IP is the `cf-connecting-ip` header Cloudflare sets at the edge. Anything else
 * (`x-forwarded-for`, the socket peer) is attacker-influencable upstream of the
 * Worker and must never be keyed on — a spoofable key both defeats per-IP
 * accounting and lets one attacker exhaust another client's budget.
 *
 * This delegates to the hardened `@shared/rate-limit` `getClientIp` (W3) with
 * `trustCloudflare: true`: it returns the validated `cf-connecting-ip`, or the
 * `UNRESOLVED_IP` sentinel when the header is missing/malformed. Callers MUST
 * treat the sentinel as "fail closed" (HTTP 429) via {@link isUnresolvedIp}
 * rather than bucketing every header-less request together — see
 * `rateLimitMiddleware`.
 */

import { getClientIp as sharedGetClientIp, isUnresolvedIp } from "@shared/rate-limit";

export { isUnresolvedIp };

/**
 * Cloudflare-only client-IP resolution. Returns the validated `cf-connecting-ip`
 * or the unresolved sentinel (never a spoofable XFF / "unknown" fallback).
 */
export function getClientIp(headers: Headers): string {
  return sharedGetClientIp(
    { "cf-connecting-ip": headers.get("cf-connecting-ip") ?? undefined },
    { trustCloudflare: true },
  );
}
