import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import {
  generatePublicId,
  generatePassword,
  hashPassword,
  verifyPassword,
  normaliseSurname,
} from "./family-id";
import { THREE_LETTER_WORDS, PASSWORD_WORDS } from "./wordlist";
import { eff } from "../test-helpers";

const PUBLIC_ID_RE = /^[A-Z]+-[A-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/;
const PASSWORD_RE = /^[a-z]+(-[a-z]+){3}$/;

describe("normaliseSurname", () => {
  it("uppercases simple ascii names", () => {
    expect(normaliseSurname("Pradheep")).toBe("PRADHEEP");
  });

  it("strips diacritics", () => {
    expect(normaliseSurname("Müller")).toBe("MULLER");
    expect(normaliseSurname("Renée")).toBe("RENEE");
  });

  it("strips whitespace and punctuation", () => {
    expect(normaliseSurname("O'Brien")).toBe("OBRIEN");
    expect(normaliseSurname("Van Der Berg")).toBe("VANDERBERG");
    expect(normaliseSurname("St. James")).toBe("STJAMES");
  });

  it("falls back to FAMILY when nothing remains", () => {
    expect(normaliseSurname("123")).toBe("FAMILY");
    expect(normaliseSurname("")).toBe("FAMILY");
    expect(normaliseSurname("---")).toBe("FAMILY");
  });
});

describe("generatePublicId", () => {
  it("matches SURNAME-WORD-HASH format", () => {
    const id = generatePublicId("Pradheep");
    expect(id).toMatch(PUBLIC_ID_RE);
    expect(id.startsWith("PRADHEEP-")).toBe(true);
  });

  it("uses an allowed word from the wordlist", () => {
    for (let i = 0; i < 50; i++) {
      const id = generatePublicId("Test");
      const word = id.split("-")[1]!;
      expect(THREE_LETTER_WORDS).toContain(word);
    }
  });

  it("uses Crockford Base32 (no I, L, O, U) in the hash segment", () => {
    for (let i = 0; i < 200; i++) {
      const hash = generatePublicId("Test").split("-")[2]!;
      expect(hash).not.toMatch(/[ILOU]/);
      expect(hash).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it("produces 1000 unique ids in a batch (collision sanity)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generatePublicId("Test"));
    expect(ids.size).toBe(1000);
  });

  it("normalises the surname segment", () => {
    expect(generatePublicId("O'Brien").startsWith("OBRIEN-")).toBe(true);
    expect(generatePublicId("Van Der Berg").startsWith("VANDERBERG-")).toBe(true);
  });
});

describe("generatePassword", () => {
  it("returns 4 lowercase hyphen-separated words from the wordlist", () => {
    const pw = generatePassword();
    expect(pw).toMatch(PASSWORD_RE);
    for (const word of pw.split("-")) {
      expect(PASSWORD_WORDS).toContain(word);
    }
  });

  it("produces 1000 unique passphrases in a batch (collision sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generatePassword());
    expect(seen.size).toBe(1000);
  });
});

describe("hashPassword + verifyPassword", () => {
  it(
    "produces an encoded hash with the documented shape",
    eff(
      Effect.gen(function* () {
        const encoded = yield* hashPassword("amber-cedar-violin-ridge");
        expect(encoded).toMatch(/^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
      }),
    ),
  );

  it(
    "produces a different hash each call (random salt)",
    eff(
      Effect.gen(function* () {
        const a = yield* hashPassword("amber-cedar-violin-ridge");
        const b = yield* hashPassword("amber-cedar-violin-ridge");
        expect(a).not.toBe(b);
      }),
    ),
  );

  it(
    "verifies the correct password",
    eff(
      Effect.gen(function* () {
        const encoded = yield* hashPassword("amber-cedar-violin-ridge");
        const ok = yield* verifyPassword("amber-cedar-violin-ridge", encoded);
        expect(ok).toBe(true);
      }),
    ),
  );

  it(
    "rejects the wrong password",
    eff(
      Effect.gen(function* () {
        const encoded = yield* hashPassword("amber-cedar-violin-ridge");
        const ok = yield* verifyPassword("wrong-words-here-now", encoded);
        expect(ok).toBe(false);
      }),
    ),
  );

  it(
    "returns false for malformed encoded strings (does not throw)",
    eff(
      Effect.gen(function* () {
        expect(yield* verifyPassword("anything", "not-a-hash")).toBe(false);
        expect(yield* verifyPassword("anything", "pbkdf2$sha256$100000$x")).toBe(false);
        expect(yield* verifyPassword("anything", "")).toBe(false);
      }),
    ),
  );

  it(
    "returns false when iterations segment is not a positive integer",
    eff(
      Effect.gen(function* () {
        expect(yield* verifyPassword("anything", "pbkdf2$sha256$abc$AAAA$BBBB")).toBe(false);
        expect(yield* verifyPassword("anything", "pbkdf2$sha256$0$AAAA$BBBB")).toBe(false);
        expect(yield* verifyPassword("anything", "pbkdf2$sha256$-100$AAAA$BBBB")).toBe(false);
      }),
    ),
  );

  it(
    "fails with HashFailure when salt or hash bytes are not valid base64",
    eff(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          verifyPassword("anything", "pbkdf2$sha256$100000$!!!$@@@"),
        );
        expect(error._tag).toBe("HashFailure");
      }),
    ),
  );
});
