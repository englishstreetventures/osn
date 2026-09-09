import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { timingSafeEqualString } from "../src/timing-safe";
import {
  base32Decode,
  base32Encode,
  deriveTotpCode,
  generateTotpSecret,
  parseTotpSecret,
  totpUri,
  verifyTotpCode,
} from "../src/totp";

/**
 * The comparison is wrapped, not replaced: every test still compares for real,
 * and the wrapper only counts. Counting is how "no early return" is asserted
 * at all — the property is about how many comparisons happen, and a timing
 * measurement would decide it differently on a loaded CI machine than on a
 * quiet one.
 */
vi.mock("../src/timing-safe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/timing-safe")>();
  return { timingSafeEqualString: vi.fn(actual.timingSafeEqualString) };
});

const comparisons = vi.mocked(timingSafeEqualString);

/**
 * The seed both RFC 4226 Appendix D and RFC 6238 Appendix B publish their
 * vectors against: the ASCII string "12345678901234567890", 20 bytes.
 */
const RFC_SEED = new TextEncoder().encode("12345678901234567890");

/** RFC 4226 Appendix D, HOTP counters 0 through 9. Six digits, as published. */
const HOTP_VECTORS = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

/**
 * RFC 6238 Appendix B, the SHA-1 rows. The RFC publishes eight digits; this
 * module derives six, and the low six of the published value is exactly that
 * — dynamic truncation yields a 31-bit integer and the code is
 * `truncated % 10**digits`, so `(x % 10**8) % 10**6 === x % 10**6` because
 * 10**6 divides 10**8.
 */
const TOTP_VECTORS = [
  { seconds: 59, eightDigit: "94287082" },
  { seconds: 1_111_111_109, eightDigit: "07081804" },
  { seconds: 1_111_111_111, eightDigit: "14050471" },
  { seconds: 1_234_567_890, eightDigit: "89005924" },
  { seconds: 2_000_000_000, eightDigit: "69279037" },
  { seconds: 20_000_000_000, eightDigit: "65353130" },
];

/** RFC 4648 §10, base32 column. Encoding here is unpadded. */
const BASE32_VECTORS = [
  { plain: "", encoded: "", padded: "" },
  { plain: "f", encoded: "MY", padded: "MY======" },
  { plain: "fo", encoded: "MZXQ", padded: "MZXQ====" },
  { plain: "foo", encoded: "MZXW6", padded: "MZXW6===" },
  { plain: "foob", encoded: "MZXW6YQ", padded: "MZXW6YQ=" },
  { plain: "fooba", encoded: "MZXW6YTB", padded: "MZXW6YTB" },
  { plain: "foobar", encoded: "MZXW6YTBOI", padded: "MZXW6YTBOI======" },
];

/** The RFC seed, base32-encoded — the string an authenticator app receives. */
const RFC_SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const TOTP_STEP_SECONDS = 30;

function counterAt(seconds: number): number {
  return Math.floor(seconds / TOTP_STEP_SECONDS);
}

/**
 * A six-digit code no candidate in the window can equal, chosen rather than
 * assumed: of the ten repeated-digit codes at most three are in any window, so
 * one of them is always free and the test never turns on a one-in-a-million
 * collision.
 */
async function unmatchableCode(secret: Uint8Array, counter: number, span: number): Promise<string> {
  const accepted = new Set(
    await Promise.all(
      Array.from({ length: span * 2 + 1 }, (_, index) =>
        deriveTotpCode(secret, counter - span + index),
      ),
    ),
  );
  const free = Array.from({ length: 10 }, (_, digit) => String(digit).repeat(6)).find(
    (candidate) => !accepted.has(candidate),
  );
  if (free === undefined) throw new Error("every repeated-digit code was in the window");
  return free;
}

describe("deriveTotpCode — RFC 4226 Appendix D", () => {
  it.each(HOTP_VECTORS.map((code, counter) => ({ counter, code })))(
    "counter $counter derives $code",
    async ({ counter, code }) => {
      expect(await deriveTotpCode(RFC_SEED, counter)).toBe(code);
    },
  );
});

describe("deriveTotpCode — RFC 6238 Appendix B", () => {
  it.each(TOTP_VECTORS)("t=$seconds derives the low six of $eightDigit", async (vector) => {
    expect(await deriveTotpCode(RFC_SEED, counterAt(vector.seconds))).toBe(
      vector.eightDigit.slice(-6),
    );
  });
});

describe("deriveTotpCode — rejected inputs", () => {
  it("rejects a negative counter rather than wrapping it", async () => {
    await expect(deriveTotpCode(RFC_SEED, -1)).rejects.toThrow(TypeError);
  });

  it("rejects a non-integer counter", async () => {
    await expect(deriveTotpCode(RFC_SEED, 1.5)).rejects.toThrow(TypeError);
  });

  it("rejects a secret below the 128-bit floor", async () => {
    await expect(deriveTotpCode(new Uint8Array(15), 1)).rejects.toThrow(TypeError);
  });

  it("rejects an empty secret", async () => {
    await expect(deriveTotpCode(new Uint8Array(0), 1)).rejects.toThrow(TypeError);
  });

  it("accepts a secret of exactly the 128-bit floor", async () => {
    await expect(deriveTotpCode(new Uint8Array(16), 1)).resolves.toMatch(/^[0-9]{6}$/);
  });
});

describe("base32Encode — RFC 4648 §10", () => {
  it.each(BASE32_VECTORS)('encodes "$plain" as $encoded', ({ plain, encoded }) => {
    expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded);
  });

  it("emits only uppercase alphabet characters and no padding", () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      expect(base32Encode(bytes)).toMatch(/^[A-Z2-7]*$/);
    }
  });
});

describe("base32Decode — RFC 4648 §10", () => {
  it.each(BASE32_VECTORS)('decodes $encoded to "$plain"', ({ plain, encoded }) => {
    expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain);
  });

  it.each(BASE32_VECTORS)('decodes the padded form $padded to "$plain"', ({ plain, padded }) => {
    expect(new TextDecoder().decode(base32Decode(padded))).toBe(plain);
  });

  it("round-trips every byte length from 0 to 40", () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      expect([...base32Decode(base32Encode(bytes))]).toStrictEqual([...bytes]);
    }
  });

  it("accepts lowercase, spaced and padded spellings of the same secret", () => {
    const canonical = [...base32Decode(RFC_SEED_BASE32)];
    expect([...base32Decode(RFC_SEED_BASE32.toLowerCase())]).toStrictEqual(canonical);
    expect([...base32Decode("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ")]).toStrictEqual(canonical);
    expect([...base32Decode(`${RFC_SEED_BASE32}======`)]).toStrictEqual(canonical);
  });

  it.each(["0", "1", "8", "9", "-", "!", "@", "ß", "ſ", "ı"])(
    "rejects %s, which is outside the alphabet",
    (character) => {
      expect(() => base32Decode(`MZXW6YTB${character}`)).toThrow(TypeError);
    },
  );

  it("keeps the rejected input out of the error message", () => {
    let message = "";
    try {
      base32Decode("MZXW6YTB!");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("MZXW6YTB");
    expect(message).not.toContain("!");
  });

  it.each([1, 3, 6])("drops the leftover bits of a %s-character input", (length) => {
    const truncated = RFC_SEED_BASE32.slice(0, length);
    expect(base32Decode(truncated)).toHaveLength(Math.floor((length * 5) / 8));
  });
});

describe("base32Decode — bounded work", () => {
  it("decodes an input at the 512-character ceiling", () => {
    expect(base32Decode("A".repeat(512))).toHaveLength(320);
  });

  it("rejects an input above the ceiling rather than decoding it", () => {
    expect(() => base32Decode("A".repeat(513))).toThrow(TypeError);
  });

  it("rejects on the length it was given, before whitespace is stripped", () => {
    expect(() => base32Decode(`${RFC_SEED_BASE32}${" ".repeat(600)}`)).toThrow(TypeError);
  });

  it("keeps the rejected input out of the error message", () => {
    let message = "";
    try {
      base32Decode("MZXW6YTB".repeat(100));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("MZXW6YTB");
  });
});

describe("parseTotpSecret", () => {
  it("decodes the published seed encoding into the Appendix B seed", () => {
    expect([...parseTotpSecret(RFC_SEED_BASE32)]).toStrictEqual([...RFC_SEED]);
  });

  it("accepts the spellings the codec accepts", () => {
    expect([...parseTotpSecret("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")]).toStrictEqual([
      ...RFC_SEED,
    ]);
    expect([...parseTotpSecret(`${RFC_SEED_BASE32}======`)]).toStrictEqual([...RFC_SEED]);
  });

  it("accepts a secret of exactly the 128-bit floor", () => {
    expect(parseTotpSecret(base32Encode(RFC_SEED.slice(0, 16)))).toHaveLength(16);
  });

  it("rejects a secret one byte below the floor", () => {
    expect(() => parseTotpSecret(base32Encode(RFC_SEED.slice(0, 15)))).toThrow(TypeError);
  });

  it.each(["A", "AB", ""])("rejects %j, which carries no whole byte at all", (input) => {
    expect(() => parseTotpSecret(input)).toThrow(TypeError);
  });

  it("rejects a character outside the alphabet, as the codec does", () => {
    expect(() => parseTotpSecret(`${RFC_SEED_BASE32}!`)).toThrow(TypeError);
  });

  it("keeps the rejected input out of the error message", () => {
    let message = "";
    try {
      parseTotpSecret("MZXW6YTB");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("MZXW6YTB");
  });
});

describe("base32 and the code derivation agree", () => {
  it("decodes the published seed encoding back into the Appendix B seed", async () => {
    const decoded = base32Decode(RFC_SEED_BASE32);
    expect([...decoded]).toStrictEqual([...RFC_SEED]);
    expect(await deriveTotpCode(decoded, 1)).toBe("287082");
  });
});

describe("verifyTotpCode — RFC 6238 Appendix B", () => {
  it.each(TOTP_VECTORS)("accepts the published code at t=$seconds", async (vector) => {
    const accepted = await verifyTotpCode({
      secret: RFC_SEED,
      code: vector.eightDigit.slice(-6),
      at: new Date(vector.seconds * 1000),
    });
    expect(accepted).toBe(true);
  });
});

describe("verifyTotpCode — drift window", () => {
  const at = new Date(1_111_111_111 * 1000);
  const counter = counterAt(1_111_111_111);

  it("accepts the previous, current and next step at window 1", async () => {
    for (const offset of [-1, 0, 1]) {
      const code = await deriveTotpCode(RFC_SEED, counter + offset);
      expect(await verifyTotpCode({ secret: RFC_SEED, code, at })).toBe(true);
    }
  });

  it("rejects the steps either side of that window", async () => {
    for (const offset of [-2, 2]) {
      const code = await deriveTotpCode(RFC_SEED, counter + offset);
      expect(await verifyTotpCode({ secret: RFC_SEED, code, at })).toBe(false);
    }
  });

  it("accepts only the current step at window 0", async () => {
    const current = await deriveTotpCode(RFC_SEED, counter);
    const next = await deriveTotpCode(RFC_SEED, counter + 1);
    expect(await verifyTotpCode({ secret: RFC_SEED, code: current, at, window: 0 })).toBe(true);
    expect(await verifyTotpCode({ secret: RFC_SEED, code: next, at, window: 0 })).toBe(false);
  });

  it("clamps a large window rather than deriving unbounded candidates", async () => {
    const inside = await deriveTotpCode(RFC_SEED, counter + 10);
    const outside = await deriveTotpCode(RFC_SEED, counter + 11);
    expect(await verifyTotpCode({ secret: RFC_SEED, code: inside, at, window: 100 })).toBe(true);
    expect(await verifyTotpCode({ secret: RFC_SEED, code: outside, at, window: 100 })).toBe(false);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.4])(
    "collapses a window of %s to the current step, and still accepts it",
    async (window) => {
      const current = await deriveTotpCode(RFC_SEED, counter);
      const next = await deriveTotpCode(RFC_SEED, counter + 1);
      expect(await verifyTotpCode({ secret: RFC_SEED, code: current, at, window })).toBe(true);
      expect(await verifyTotpCode({ secret: RFC_SEED, code: next, at, window })).toBe(false);
    },
  );
});

describe("verifyTotpCode — the same work wherever the match is", () => {
  const at = new Date(1_111_111_111 * 1000);
  const counter = counterAt(1_111_111_111);
  const WINDOW = 1;
  const CANDIDATES = WINDOW * 2 + 1;

  let signatures: MockInstance<SubtleCrypto["sign"]>;

  beforeEach(() => {
    signatures = vi.spyOn(crypto.subtle, "sign");
  });

  afterEach(() => {
    signatures.mockRestore();
  });

  it.each([
    { where: "the first candidate", offset: -1 },
    { where: "the middle candidate", offset: 0 },
    { where: "the last candidate", offset: 1 },
  ])("derives and compares every candidate when the code matches $where", async ({ offset }) => {
    const code = await deriveTotpCode(RFC_SEED, counter + offset);
    comparisons.mockClear();
    signatures.mockClear();

    expect(await verifyTotpCode({ secret: RFC_SEED, code, at, window: WINDOW })).toBe(true);

    expect(comparisons).toHaveBeenCalledTimes(CANDIDATES);
    expect(signatures).toHaveBeenCalledTimes(CANDIDATES);
  });

  it("derives and compares every candidate when the code matches none of them", async () => {
    const code = await unmatchableCode(RFC_SEED, counter, WINDOW);
    comparisons.mockClear();
    signatures.mockClear();

    expect(await verifyTotpCode({ secret: RFC_SEED, code, at, window: WINDOW })).toBe(false);

    expect(comparisons).toHaveBeenCalledTimes(CANDIDATES);
    expect(signatures).toHaveBeenCalledTimes(CANDIDATES);
  });

  it.each([0, 15])(
    "does the same work for a %s-byte secret it cannot verify against",
    async (length) => {
      comparisons.mockClear();
      signatures.mockClear();

      expect(
        await verifyTotpCode({
          secret: new Uint8Array(length),
          code: "123456",
          at,
          window: WINDOW,
        }),
      ).toBe(false);

      expect(comparisons).toHaveBeenCalledTimes(CANDIDATES);
      expect(signatures).toHaveBeenCalledTimes(CANDIDATES);
    },
  );
});

describe("verifyTotpCode — the code guard runs before any HMAC", () => {
  const at = new Date(1_111_111_111 * 1000);

  let signatures: MockInstance<SubtleCrypto["sign"]>;

  beforeEach(() => {
    signatures = vi.spyOn(crypto.subtle, "sign");
  });

  afterEach(() => {
    signatures.mockRestore();
  });

  it.each(["1234567", "12345", "12a456", ""])("derives nothing for %j", async (code) => {
    expect(await verifyTotpCode({ secret: RFC_SEED, code, at })).toBe(false);
    expect(signatures).not.toHaveBeenCalled();
  });
});

describe("verifyTotpCode — malformed input", () => {
  const at = new Date(1_111_111_111 * 1000);

  it.each(["12345", "1234567", "12a456", "", "12 456", "12345 ", "123456\n", "１２３４５６"])(
    "rejects %j without throwing",
    async (code) => {
      expect(await verifyTotpCode({ secret: RFC_SEED, code, at })).toBe(false);
    },
  );

  it("returns false for an invalid date rather than throwing", async () => {
    const code = await deriveTotpCode(RFC_SEED, counterAt(1_111_111_111));
    expect(await verifyTotpCode({ secret: RFC_SEED, code, at: new Date("not a date") })).toBe(
      false,
    );
  });

  it("returns false for a pre-1970 date, whose step counter is negative", async () => {
    // The code for counter 0 — what a negative counter clamps to if it is not
    // refused first, and so the code such a date would wrongly accept.
    expect(
      await verifyTotpCode({ secret: RFC_SEED, code: HOTP_VECTORS[0], at: new Date(-1000) }),
    ).toBe(false);
  });

  it("returns false for a secret below the 128-bit floor rather than throwing", async () => {
    expect(await verifyTotpCode({ secret: new Uint8Array(15), code: "123456", at })).toBe(false);
  });

  it("returns false for an empty secret rather than throwing", async () => {
    expect(await verifyTotpCode({ secret: new Uint8Array(0), code: "123456", at })).toBe(false);
  });

  it("verifies against a secret of exactly the 128-bit floor", async () => {
    const secret = RFC_SEED.slice(0, 16);
    const code = await deriveTotpCode(secret, counterAt(1_111_111_111));
    expect(await verifyTotpCode({ secret, code, at })).toBe(true);
  });
});

describe("generateTotpSecret", () => {
  it("produces 20 bytes", () => {
    expect(generateTotpSecret()).toHaveLength(20);
  });

  it("produces a fresh secret on each call", () => {
    const seen = new Set(Array.from({ length: 100 }, () => base32Encode(generateTotpSecret())));
    expect(seen.size).toBe(100);
  });
});

describe("totpUri", () => {
  it("carries the secret, the issuer and the algorithm parameters", () => {
    const uri = new URL(totpUri({ secret: RFC_SEED, accountName: "ada", issuer: "OSN" }));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.pathname).toBe("/OSN:ada");
    expect(uri.searchParams.get("secret")).toBe(RFC_SEED_BASE32);
    expect(uri.searchParams.get("issuer")).toBe("OSN");
    expect(uri.searchParams.get("algorithm")).toBe("SHA1");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
  });

  it("percent-encodes a space, a colon and a non-ASCII character in both fields", () => {
    const raw = totpUri({
      secret: RFC_SEED,
      accountName: "adá lovelace:1",
      issuer: "Musubi Social: ID",
    });

    expect(raw).toContain("otpauth://totp/Musubi%20Social%3A%20ID:ad%C3%A1%20lovelace%3A1?");
    expect(raw).toContain("issuer=Musubi%20Social%3A%20ID");

    const uri = new URL(raw);
    expect(uri.searchParams.get("issuer")).toBe("Musubi Social: ID");
    expect(decodeURIComponent(uri.pathname.slice(1))).toBe("Musubi Social: ID:adá lovelace:1");
  });

  it("emits a secret an authenticator can decode back to the seed", () => {
    const secret = generateTotpSecret();
    const uri = new URL(totpUri({ secret, accountName: "ada", issuer: "OSN" }));
    expect([...base32Decode(uri.searchParams.get("secret") ?? "")]).toStrictEqual([...secret]);
  });

  it.each([0, 4, 15])("refuses to encode a %s-byte secret into a QR code", (length) => {
    expect(() =>
      totpUri({ secret: new Uint8Array(length), accountName: "ada", issuer: "OSN" }),
    ).toThrow(TypeError);
  });

  it("encodes a secret of exactly the 128-bit floor", () => {
    const uri = new URL(
      totpUri({ secret: RFC_SEED.slice(0, 16), accountName: "ada", issuer: "OSN" }),
    );
    expect(base32Decode(uri.searchParams.get("secret") ?? "")).toHaveLength(16);
  });
});

describe("the ./totp subpath", () => {
  it("resolves through the package's own exports map", async () => {
    const viaSubpath = await import("@shared/crypto/totp");
    expect(viaSubpath.verifyTotpCode).toBe(verifyTotpCode);
    expect(viaSubpath.deriveTotpCode).toBe(deriveTotpCode);
    expect(viaSubpath.base32Decode).toBe(base32Decode);
    expect(viaSubpath.parseTotpSecret).toBe(parseTotpSecret);
  });
});
