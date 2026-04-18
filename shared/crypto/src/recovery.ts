import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Copenhagen Book M2 — single-use recovery codes.
 *
 * Generated once (shown to the user), never displayed again, and consumed
 * individually during an account-recovery login. Each code is 64 bits of
 * entropy (16 hex chars, displayed in groups of four for readability).
 *
 * # Threat model
 *
 * Recovery codes unlock a full session if all passkeys are lost. The server
 * stores only SHA-256(code) — a database leak does not expose usable codes
 * because the preimage space is 2^64, well beyond feasible brute force per
 * hash with the salt provided by the prefix. We deliberately skip a
 * memory-hard KDF here: unlike user-chosen passwords these are uniformly
 * random high-entropy secrets, so SHA-256 is appropriate (same reasoning as
 * session tokens in `[[sessions]]`).
 *
 * # Code format
 *
 * `xxxx-xxxx-xxxx-xxxx` — 16 lowercase hex characters in 4 groups of 4,
 * separated by ASCII hyphens. Users can type the dashes or omit them; we
 * normalise on compare.
 */

/** Length of the raw hex code, excluding separators. */
const CODE_HEX_LENGTH = 16;

/** Default number of codes per generation. */
export const RECOVERY_CODE_COUNT = 10;

/** Generates one recovery code with 64 bits of entropy. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_HEX_LENGTH / 2);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/** Generates a full batch of `count` recovery codes. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Strips separators and lowercases before hashing so the user can type the
 * dashed or undashed form and still match. Non-hex characters are stripped
 * too — typos like spaces are accommodated.
 */
function normaliseCode(input: string): string {
  return input.toLowerCase().replace(/[^0-9a-f]/g, "");
}

/**
 * SHA-256 hash of the normalised code. Hex-encoded so it sits naturally in
 * a TEXT column and can be compared byte-for-byte.
 */
export function hashRecoveryCode(code: string): string {
  const normalised = normaliseCode(code);
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * Constant-time comparison of a user-supplied code against a stored hash.
 * Returns false for length mismatch (the hash is always 64 hex chars so a
 * mismatch here indicates a malformed stored value — treat as invalid).
 */
export function verifyRecoveryCode(input: string, storedHash: string): boolean {
  const computed = hashRecoveryCode(input);
  if (computed.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(storedHash, "utf8"));
}
