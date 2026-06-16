/**
 * Resolve the caller's IP for per-IP rate limiting.
 *
 * cire/api runs behind Cloudflare, which sets `cf-connecting-ip` to the real
 * client address on every request. That header is set by the edge and cannot
 * be spoofed by the client. We deliberately do NOT fall back to
 * `x-forwarded-for`: an attacker can send an arbitrary `X-Forwarded-For` value
 * and would otherwise rotate it to mint a fresh rate-limit bucket per request,
 * defeating the limiter (C4). We also drop the old `"unknown"` bucket — sharing
 * a single bucket across all IP-less requests is itself an amplifier and masks
 * a misconfigured edge.
 *
 * Returns `null` when the IP cannot be trusted. Callers MUST fail closed
 * (deny the request) on `null` for pre-auth state-changing routes — an
 * unresolved IP is a deny, not a free pass.
 */
export function getClientIp(headers: Headers): string | null {
  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp) {
    const trimmed = cfIp.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
