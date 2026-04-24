import { describe, it, expect } from "vitest";

import {
  MAX_PRICE_MAJOR,
  MAX_PRICE_MINOR,
  SUPPORTED_CURRENCIES,
  currencyExponent,
  fromMinorUnits,
  isSupportedCurrency,
  toMinorUnits,
} from "../../src/lib/currency";

describe("toMinorUnits", () => {
  it("converts USD decimals to cents (integer)", () => {
    expect(toMinorUnits(18.5, "USD")).toBe(1850);
  });

  it("converts USD whole numbers to cents", () => {
    expect(toMinorUnits(10, "USD")).toBe(1000);
  });

  it("treats JPY as zero-exponent (major === minor)", () => {
    expect(toMinorUnits(500, "JPY")).toBe(500);
  });

  it("rounds half-up on USD sub-cent input", () => {
    expect(toMinorUnits(18.505, "USD")).toBe(1851);
  });

  it("rounds half-down correctly", () => {
    expect(toMinorUnits(18.504, "USD")).toBe(1850);
  });

  it("handles 0", () => {
    expect(toMinorUnits(0, "USD")).toBe(0);
  });
});

describe("fromMinorUnits", () => {
  it("converts USD cents to decimal", () => {
    expect(fromMinorUnits(1850, "USD")).toBe(18.5);
  });

  it("treats JPY as zero-exponent (minor === major)", () => {
    expect(fromMinorUnits(500, "JPY")).toBe(500);
  });

  it("round-trips through toMinorUnits / fromMinorUnits for USD", () => {
    expect(fromMinorUnits(toMinorUnits(18.5, "USD"), "USD")).toBe(18.5);
  });

  it("round-trips through toMinorUnits / fromMinorUnits for JPY", () => {
    expect(fromMinorUnits(toMinorUnits(500, "JPY"), "JPY")).toBe(500);
  });
});

describe("currencyExponent", () => {
  it("returns 2 for USD/EUR/GBP/CAD/AUD", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("GBP")).toBe(2);
    expect(currencyExponent("CAD")).toBe(2);
    expect(currencyExponent("AUD")).toBe(2);
  });

  it("returns 0 for JPY", () => {
    expect(currencyExponent("JPY")).toBe(0);
  });
});

describe("isSupportedCurrency", () => {
  it("accepts every code in SUPPORTED_CURRENCIES", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      expect(isSupportedCurrency(c)).toBe(true);
    }
  });

  it("is case-sensitive (lowercase rejected)", () => {
    expect(isSupportedCurrency("usd")).toBe(false);
  });

  it("rejects unknown codes", () => {
    expect(isSupportedCurrency("XYZ")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isSupportedCurrency(null)).toBe(false);
    expect(isSupportedCurrency(undefined)).toBe(false);
    expect(isSupportedCurrency(123)).toBe(false);
    expect(isSupportedCurrency({})).toBe(false);
  });
});

describe("price caps", () => {
  it("MAX_PRICE_MAJOR × 100 === MAX_PRICE_MINOR (USD assumption)", () => {
    expect(MAX_PRICE_MAJOR * 100).toBe(MAX_PRICE_MINOR);
  });

  it("cap converted via toMinorUnits stays within MAX_PRICE_MINOR", () => {
    expect(toMinorUnits(MAX_PRICE_MAJOR, "USD")).toBe(MAX_PRICE_MINOR);
  });
});
