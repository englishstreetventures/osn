/**
 * Family claim-code generator (C1).
 *
 * Format `SURNAME-WORD-HASH`:
 *  - SURNAME — the uppercased family surname. **Readability only, NON-SECURITY.**
 *    Collisions on surname are expected and fine; entropy lives entirely in
 *    WORD + HASH. An empty/symbol-only surname degrades to `FAMILY`.
 *  - WORD    — one word chosen uniformly at random from the EFF short wordlist
 *    (1296 words → ~10.34 bits). Disambiguates same-surname families with a
 *    human-pronounceable token rather than a second hash block.
 *  - HASH    — Crockford base32 (alphabet excludes I/L/O/U to avoid
 *    transcription ambiguity), grouped for readability. Length is tier-driven:
 *      · `secure` (default) — 10 chars → ~50 bits, grouped 5-5
 *        (total code ≈ 10.34 + 50 ≈ 60 bits)
 *      · `simple`           — 6 chars  → ~30 bits, ungrouped
 *        (total code ≈ 10.34 + 30 ≈ 40 bits)
 *
 * Entry is case-insensitive: the claim path upper-cases input before lookup, and
 * Crockford base32 has no lowercase ambiguity. The generator only ever emits
 * upper-case so the stored `families.public_id` is canonical.
 *
 * Randomness is `crypto.getRandomValues` (CSPRNG, available on workerd + bun).
 * Selection is rejection-sampled so every word / symbol is equiprobable — no
 * modulo bias.
 */

import { WORDLIST } from "../data/eff-short-wordlist";

/** Crockford base32 alphabet — excludes I, L, O, U (ambiguous / accidental words). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Per-wedding code tier. Mirrors the `weddings.code_style` D1 column. */
export type CodeStyle = "simple" | "secure";

/** Hash length (Crockford chars) per tier. */
const HASH_LEN: Record<CodeStyle, number> = {
  // 6 chars × 5 bits = 30 bits.
  simple: 6,
  // 10 chars × 5 bits = 50 bits.
  secure: 10,
};

/**
 * Draw a uniformly-random integer in `[0, max)` from the CSPRNG without modulo
 * bias. Rejects the unrepresentable tail of the byte range so every value is
 * equiprobable. `max` is small here (≤1296 / ≤32) so rejection is rare.
 */
function uniformInt(max: number): number {
  if (max <= 0 || max > 0x1_00_00) {
    throw new RangeError(`uniformInt: max out of range (${max})`);
  }
  // Two bytes cover both our ranges (wordlist 1296, alphabet 32).
  const limit = Math.floor(0x1_00_00 / max) * max;
  const buf = new Uint16Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % max;
  }
}

/** Uppercase + collapse non-alphanumerics; cap length. `""` → `"FAMILY"`. */
export function normaliseSurname(familyName: string): string {
  const base = familyName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 16);
  return base || "FAMILY";
}

/** One uniformly-random EFF-short word, upper-cased. */
function randomWord(): string {
  return WORDLIST[uniformInt(WORDLIST.length)]!.toUpperCase();
}

/** `len` uniformly-random Crockford base32 chars. */
function randomHash(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += CROCKFORD[uniformInt(CROCKFORD.length)];
  return out;
}

/** Insert a single `-` at the midpoint of an even-length hash for readability. */
function groupHash(hash: string): string {
  if (hash.length % 2 !== 0) return hash;
  const mid = hash.length / 2;
  return `${hash.slice(0, mid)}-${hash.slice(mid)}`;
}

/**
 * Mint a `SURNAME-WORD-HASH` claim code for `familyName` at the given tier.
 *
 * `secure` (default) groups the 10-char hash 5-5 (`SHARMA-WIDGET-AB3K9-X7QPM`);
 * `simple` keeps the 6-char hash ungrouped (`SHARMA-WIDGET-AB3K9X`). The surname
 * + word segments are identical across tiers — only the hash length/grouping
 * changes the entropy.
 */
export function generateFamilyCode(familyName: string, style: CodeStyle = "secure"): string {
  const surname = normaliseSurname(familyName);
  const word = randomWord();
  const rawHash = randomHash(HASH_LEN[style]);
  const hash = style === "secure" ? groupHash(rawHash) : rawHash;
  return `${surname}-${word}-${hash}`;
}
