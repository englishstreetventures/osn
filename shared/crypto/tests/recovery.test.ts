import { describe, it, expect } from "vitest";

import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "../src/recovery";

describe("generateRecoveryCode", () => {
  it("produces dashed hex of the expected shape", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it("produces fresh codes on each call", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(100);
  });
});

describe("generateRecoveryCodes", () => {
  it("defaults to RECOVERY_CODE_COUNT codes", () => {
    const batch = generateRecoveryCodes();
    expect(batch).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("honours a custom count", () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });
});

describe("hashRecoveryCode", () => {
  it("produces the same hash for dashed and undashed input", () => {
    const code = "abcd-1234-5678-ef00";
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode("abcd12345678ef00"));
  });

  it("is case-insensitive", () => {
    expect(hashRecoveryCode("ABCD-1234-5678-EF00")).toBe(hashRecoveryCode("abcd-1234-5678-ef00"));
  });

  it("ignores whitespace", () => {
    expect(hashRecoveryCode("abcd 1234 5678 ef00")).toBe(hashRecoveryCode("abcd-1234-5678-ef00"));
  });
});

describe("verifyRecoveryCode", () => {
  it("accepts a matching code against its hash", () => {
    const code = generateRecoveryCode();
    expect(verifyRecoveryCode(code, hashRecoveryCode(code))).toBe(true);
  });

  it("rejects a different code", () => {
    const code = generateRecoveryCode();
    const other = generateRecoveryCode();
    expect(verifyRecoveryCode(other, hashRecoveryCode(code))).toBe(false);
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(verifyRecoveryCode("abcd-1234-5678-ef00", "too short")).toBe(false);
  });
});
