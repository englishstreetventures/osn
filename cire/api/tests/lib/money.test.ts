import { describe, it, expect, beforeEach } from "bun:test";

import { minorToDecimal, resetMoneyCache } from "../../src/lib/money";

beforeEach(() => {
  resetMoneyCache();
});

describe("minorToDecimal", () => {
  it("renders a two-exponent currency with its cents", () => {
    expect(minorToDecimal(12_500, "AUD")).toBe("125.00");
    expect(minorToDecimal(0, "USD")).toBe("0.00");
  });

  it("renders a zero-exponent currency as a whole number", () => {
    // The hard-coded `/ 100` this replaces would have said "200.00" — a 100×
    // understatement of a ¥20,000 gift.
    expect(minorToDecimal(20_000, "JPY")).toBe("20000");
  });

  it("renders a three-exponent currency with its thousandths", () => {
    expect(minorToDecimal(1250, "KWD")).toBe("1.250");
  });

  it("falls back to two decimals for a currency Intl rejects", () => {
    // A bad code must still print an amount: the export is a record, and a
    // throw here would take the whole download down.
    expect(minorToDecimal(12_500, "XX")).toBe("125.00");
  });

  it("returns the same answer on the memoised second call", () => {
    expect(minorToDecimal(20_000, "JPY")).toBe("20000");
    expect(minorToDecimal(1500, "JPY")).toBe("1500");
  });
});
