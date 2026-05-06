/**
 * Constant-time string equality. Workers don't expose
 * `crypto.subtle.timingSafeEqual`, so we hand-roll an XOR-fold.
 *
 * Note: this leaks length (an early-return on length-mismatch is fine — the
 * attacker already controls input length). What it protects is the per-byte
 * comparison time on length-equal candidates.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
