import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for shared-secret / hash / opaque-token
 * comparison.
 *
 * Uses `node:crypto`'s `timingSafeEqual` (available on workerd via
 * `nodejs_compat`) rather than the global Web Crypto object, which has NO
 * `timingSafeEqual` on workerd — calling `crypto.timingSafeEqual` there throws
 * `crypto.timingSafeEqual is not a function` and 500s the request.
 *
 * `node:crypto`'s `timingSafeEqual` throws on a byte-length mismatch, so we
 * compare the UTF-8 BYTE lengths first (not JS string `.length`, which counts
 * UTF-16 code units and could let two equal-`.length` non-ASCII strings reach
 * `timingSafeEqual` with unequal byte buffers and throw). Length is not secret
 * in any of the schemes that use this (an attacker controls their own input
 * length), so returning early on unequal lengths does not weaken the
 * constant-time property for equal-length inputs.
 *
 * Deliberately its own module with NO other imports: `@shared/crypto`'s index
 * pulls in `@osn/db` + `effect` for the ARC helpers, and a caller that only
 * needs a comparison should not drag that graph in. Import it as
 * `@shared/crypto/timing-safe`.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
