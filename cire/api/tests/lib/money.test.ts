import { describe, it, expect, beforeEach } from "bun:test";

import { formatMinor, minorToDecimal, resetMoneyCache } from "../../src/lib/money";

/** What `Intl` itself prints for a MAJOR-unit amount, in the runtime's locale. */
const intl = (major: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);

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

  it("answers the same after formatMinor has cached the currency", () => {
    // The two share one cache; formatting an amount first must not change what
    // the CSV exports print.
    formatMinor(1250, "KWD");
    expect(minorToDecimal(1250, "KWD")).toBe("1.250");
    formatMinor(12_500, "XX");
    expect(minorToDecimal(12_500, "XX")).toBe("125.00");
  });
});

describe("formatMinor", () => {
  it("formats a two-exponent currency from its cents", () => {
    expect(formatMinor(45_000, "AUD")).toBe(intl(450, "AUD"));
    expect(formatMinor(1999, "EUR")).toBe(intl(19.99, "EUR"));
  });

  it("formats a zero-exponent currency without dividing it", () => {
    // A fixed `/ 100` would print ¥10 for a ¥1,000 gift.
    expect(formatMinor(1000, "JPY")).toBe(intl(1000, "JPY"));
    expect(formatMinor(1000, "JPY")).not.toBe(intl(10, "JPY"));
  });

  it("formats a three-exponent currency to the thousandth", () => {
    // A fixed `/ 100` would print 15.000 for a 1.500 dinar gift.
    expect(formatMinor(1500, "KWD")).toBe(intl(1.5, "KWD"));
    expect(formatMinor(1500, "KWD")).toContain("1.500");
  });

  it("prints the amount and the code for a currency Intl rejects", () => {
    // A bad code in one row must still print an amount, and say what it is in.
    expect(formatMinor(12_500, "XX")).toBe("125.00 XX");
  });

  it("returns the same answer on the memoised second call", () => {
    const first = formatMinor(1000, "JPY");
    expect(formatMinor(1000, "JPY")).toBe(first);
    formatMinor(12_500, "XX");
    expect(formatMinor(12_500, "XX")).toBe("125.00 XX");
  });
});
