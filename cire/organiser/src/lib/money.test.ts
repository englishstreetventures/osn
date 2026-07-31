import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetMoneyFormatters, formatMinor } from "./money";

/**
 * ENQ-P-W3. The behaviour these pin is mostly the memoisation, because that is
 * the whole point of the module and the part a refactor can silently undo — a
 * reinstated per-call `new Intl.NumberFormat` renders identically and would
 * pass every output assertion below.
 */
/**
 * Count constructions without losing real formatting. A bare `vi.spyOn` is not
 * enough: invoked with `new`, the spy yields its own instance rather than the
 * original's, so every `.format` call would blow up.
 */
function countConstructions() {
  const real = Intl.NumberFormat;
  return vi
    .spyOn(Intl, "NumberFormat")
    .mockImplementation(
      (...args: ConstructorParameters<typeof Intl.NumberFormat>) => new real(...args),
    );
}

describe("formatMinor", () => {
  afterEach(() => {
    __resetMoneyFormatters();
    vi.restoreAllMocks();
  });

  it("renders minor units as currency", () => {
    // Locale-dependent grouping/symbol placement, so assert the parts that hold
    // everywhere rather than pinning one runtime's exact string.
    const out = formatMinor(123_456, "AUD");
    expect(out).toMatch(/1[,. ]?234[.,]56/);
    expect(out).toMatch(/\$|AUD/);
  });

  it("drops the cents on request", () => {
    const out = formatMinor(500_000, "AUD", { wholeUnits: true });
    expect(out).toMatch(/5[,. ]?000/);
    // No fractional part at all — `maximumFractionDigits: 0` also rounds, so
    // this uses a round amount to keep the two behaviours separate.
    expect(out).not.toMatch(/[.,]\d\d\b/);
    expect(formatMinor(123_456, "AUD", { wholeUnits: true })).toMatch(/1[,. ]?235/);
  });

  it("builds one formatter per (currency, precision) however many times it is called", () => {
    const ctor = countConstructions();

    for (let i = 0; i < 25; i += 1) formatMinor(i * 100, "AUD");
    expect(ctor).toHaveBeenCalledTimes(1);

    // A different precision is a different formatter — but still only one.
    for (let i = 0; i < 25; i += 1) formatMinor(i * 100, "AUD", { wholeUnits: true });
    expect(ctor).toHaveBeenCalledTimes(2);

    // ...and a different currency, one more.
    formatMinor(100, "EUR");
    expect(ctor).toHaveBeenCalledTimes(3);
  });

  it("falls back to a plain number when the currency code is rejected", () => {
    // `Intl.NumberFormat` throws on a malformed code; a render must not.
    expect(formatMinor(123_456, "not-a-currency")).toBe("1234.56");
    expect(formatMinor(123_456, "not-a-currency", { wholeUnits: true })).toBe("1235");
  });

  it("remembers a rejected currency instead of throwing once per row", () => {
    // The failure path is the one that most needs memoising: constructing AND
    // throwing per row is worse than the construction the cache replaced.
    const ctor = countConstructions();
    for (let i = 0; i < 25; i += 1) formatMinor(100, "not-a-currency");
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});
