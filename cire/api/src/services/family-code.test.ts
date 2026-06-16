import { describe, it, expect } from "bun:test";

import { WORDLIST } from "../data/eff-short-wordlist";
import { generateFamilyCode, normaliseSurname } from "./family-code";

// Crockford base32 alphabet (no I/L/O/U).
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;
const WORDSET = new Set(WORDLIST.map((w) => w.toUpperCase()));

describe("eff short wordlist", () => {
  it("has exactly 1296 unique words (the entropy floor)", () => {
    expect(WORDLIST).toHaveLength(1296);
    expect(new Set(WORDLIST).size).toBe(1296);
  });

  it("is all lowercase ascii words", () => {
    expect(WORDLIST.every((w) => /^[a-z][a-z-]*[a-z]$|^[a-z]$/.test(w))).toBe(true);
  });
});

describe("normaliseSurname", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normaliseSurname("O'Brien-Smith")).toBe("OBRIENSMITH");
  });
  it("degrades an empty/symbol-only surname to FAMILY", () => {
    expect(normaliseSurname("   ")).toBe("FAMILY");
    expect(normaliseSurname("!!!")).toBe("FAMILY");
  });
  it("caps the surname length", () => {
    expect(normaliseSurname("ABCDEFGHIJKLMNOPQRSTUVWXYZ").length).toBeLessThanOrEqual(16);
  });
});

describe("generateFamilyCode", () => {
  function parts(code: string): { surname: string; word: string; hash: string } {
    const segs = code.split("-");
    // secure groups the hash 5-5 → 4 segments; simple → 3 segments.
    const surname = segs[0]!;
    const word = segs[1]!;
    const hash = segs.slice(2).join("");
    return { surname, word, hash };
  }

  it("secure (default): SURNAME-WORD-HHHHH-HHHHH, 10-char Crockford hash grouped 5-5", () => {
    const code = generateFamilyCode("Sharma");
    const segs = code.split("-");
    expect(segs).toHaveLength(4); // SHARMA WORD HHHHH HHHHH
    const { surname, word, hash } = parts(code);
    expect(surname).toBe("SHARMA");
    expect(WORDSET.has(word)).toBe(true);
    expect(hash).toHaveLength(10);
    expect(CROCKFORD.test(hash)).toBe(true);
  });

  it("simple: SURNAME-WORD-HHHHHH, 6-char ungrouped Crockford hash", () => {
    const code = generateFamilyCode("Sharma", "simple");
    const segs = code.split("-");
    expect(segs).toHaveLength(3); // SHARMA WORD HHHHHH
    const { hash } = parts(code);
    expect(hash).toHaveLength(6);
    expect(CROCKFORD.test(hash)).toBe(true);
  });

  it("never emits the ambiguous Crockford letters I/L/O/U in the hash", () => {
    for (let i = 0; i < 200; i++) {
      const { hash } = parts(generateFamilyCode("Test", "secure"));
      expect(/[ILOU]/.test(hash)).toBe(false);
    }
  });

  it("draws words across the list (not a constant) and varies the hash", () => {
    const words = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { word, hash } = parts(generateFamilyCode("Test", "secure"));
      words.add(word);
      hashes.add(hash);
    }
    // 100 draws from 1296 words → overwhelmingly likely to see many distinct.
    expect(words.size).toBeGreaterThan(20);
    // 100 distinct 50-bit hashes — collisions astronomically unlikely.
    expect(hashes.size).toBe(100);
  });

  it("secure has more hash entropy than simple (10 vs 6 chars)", () => {
    const secure = parts(generateFamilyCode("X", "secure")).hash.length;
    const simple = parts(generateFamilyCode("X", "simple")).hash.length;
    expect(secure).toBe(10);
    expect(simple).toBe(6);
    expect(secure).toBeGreaterThan(simple);
  });
});
