import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for shared-secret / hash comparison.
 *
 * Uses `node:crypto`'s `timingSafeEqual` (available on workerd via
 * `nodejs_compat`) rather than the global Web Crypto object, which has NO
 * `timingSafeEqual` on workerd — calling `crypto.timingSafeEqual` there throws
 * `crypto.timingSafeEqual is not a function`, 500ing the request (the Bug A
 * trap behind the `INTERNAL_SERVICE_SECRET` bearer check).
 *
 * `node:crypto`'s `timingSafeEqual` throws on a byte-length mismatch, so we
 * compare the UTF-8 BYTE lengths first (not JS string `.length`, which counts
 * UTF-16 code units and could let two equal-`.length` non-ASCII strings reach
 * `timingSafeEqual` with unequal byte buffers and throw). Length is not secret
 * in a `Bearer <secret>` scheme (an attacker controls their own input length),
 * so returning early on unequal lengths does not weaken the constant-time
 * property for equal-length inputs.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
