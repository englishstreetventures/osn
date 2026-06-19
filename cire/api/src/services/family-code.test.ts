import { describe, it, expect } from "bun:test";

import { MIN_WORDS, WORDLIST } from "../data/pleasant-wordlist";
import { generateFamilyCode, normaliseSurname } from "./family-code";

// Crockford base32 alphabet (no I/L/O/U).
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;
const WORDSET = new Set(WORDLIST.map((w) => w.toUpperCase()));

describe("pleasant wordlist", () => {
  it("has at least the entropy floor of unique words", () => {
    expect(WORDLIST.length).toBeGreaterThanOrEqual(MIN_WORDS);
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
  });

  it("is all lowercase 3–10 char ascii words", () => {
    expect(WORDLIST.every((w) => /^[a-z]{3,10}$/.test(w))).toBe(true);
  });

  it("contains none of the obviously-bad words (wholesome sanity guard)", () => {
    // Small deny-list of the kind of words the EFF list let through and the owner
    // objected to. None of these should ever appear in a wedding-invite code.
    const DENY = [
      "bruise",
      "wound",
      "blood",
      "death",
      "corpse",
      "vomit",
      "rotten",
      "ugly",
      "stupid",
      "demon",
      "curse",
      "venom",
      "tumor",
      "rash",
    ];
    const set = new Set(WORDLIST);
    for (const bad of DENY) expect(set.has(bad)).toBe(false);
  });
});

describe("normaliseSurname", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normaliseSurname("O'Brien-Smith")).toBe("OBRIENSMITH");
  });
  it("strips filler tokens: The Nguyen Family → NGUYEN", () => {
    expect(normaliseSurname("The Nguyen Family")).toBe("NGUYEN");
  });
  it("joins remaining tokens, dropping & : Smith & Jones → SMITHJONES", () => {
    expect(normaliseSurname("Smith & Jones")).toBe("SMITHJONES");
  });
  it("keeps a plain surname unchanged: Smith → SMITH", () => {
    expect(normaliseSurname("Smith")).toBe("SMITH");
  });
  it("keeps the bare surname when 'The' / 'Family' wrap it: The Patels → PATELS", () => {
    expect(normaliseSurname("The Patels")).toBe("PATELS");
  });
  it("degrades an empty/symbol-only surname to FAMILY", () => {
    expect(normaliseSurname("   ")).toBe("FAMILY");
    expect(normaliseSurname("!!!")).toBe("FAMILY");
  });
  it("degrades an all-filler name to FAMILY", () => {
    expect(normaliseSurname("The Family")).toBe("FAMILY");
    expect(normaliseSurname("The Household")).toBe("FAMILY");
  });
  it("caps the surname length at 16", () => {
    expect(normaliseSurname("ABCDEFGHIJKLMNOPQRSTUVWXYZ").length).toBeLessThanOrEqual(16);
    expect(normaliseSurname("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("ABCDEFGHIJKLMNOP");
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
