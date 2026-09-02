import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetMoneyFormatters,
  formatMinor,
  formatMinorPair,
  minorToInput,
  parseMinor,
} from "../../src/lib/money";

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

  it("uses each currency's real minor-unit exponent, not a fixed /100", () => {
    // The trap this pins: a fixed `/ 100` is right for AUD and wrong by 100× for
    // JPY (no minor unit at all) and 10× for the three-decimal currencies. It was
    // invisible while every wedding was in AUD, and states amounts wildly wrong
    // the moment a gift arrives in yen.
    //
    // 1000 minor units is ¥1000 — NOT ¥10.
    const jpy = formatMinor(1000, "JPY");
    expect(jpy).toMatch(/1[,. ]?000/);
    expect(jpy).not.toMatch(/\b10\b/);

    // KWD has three: 1000 minor units is 1 dinar.
    expect(formatMinor(1000, "KWD")).toMatch(/\b1[.,]000\b/);

    // AUD is unchanged — two decimals.
    expect(formatMinor(1000, "AUD")).toMatch(/\b10[.,]00\b/);
  });

  it("does not construct an extra formatter to learn the exponent", () => {
    // The exponent is read off the formatter the module already builds. If a
    // future refactor probes with its own `new Intl.NumberFormat`, the whole
    // memoisation win halves — silently, since output is identical.
    const ctor = countConstructions();
    for (let i = 0; i < 25; i += 1) formatMinor(i * 100, "JPY");
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});

describe("parseMinor", () => {
  afterEach(() => {
    __resetMoneyFormatters();
    vi.restoreAllMocks();
  });

  it("round-trips a typed major-unit amount into minor units", () => {
    expect(parseMinor("12.50", "AUD")).toBe(1250);
    expect(parseMinor(" 12 ", "AUD")).toBe(1200);
  });

  it("uses the currency's exponent rather than a hardcoded 100", () => {
    // The mistake this exists to prevent: ¥1000 typed into a price field became
    // 100_000 minor units — ¥100,000 — under a fixed `× 100`.
    expect(parseMinor("1000", "JPY")).toBe(1000);
    expect(parseMinor("1", "KWD")).toBe(1000);
  });

  it("returns null for empty, non-numeric or negative input", () => {
    expect(parseMinor("", "AUD")).toBeNull();
    expect(parseMinor("   ", "AUD")).toBeNull();
    expect(parseMinor("free", "AUD")).toBeNull();
    expect(parseMinor("-5", "AUD")).toBeNull();
  });
});

describe("minorToInput", () => {
  afterEach(() => {
    __resetMoneyFormatters();
    vi.restoreAllMocks();
  });

  it("renders a bare number a number input will accept", () => {
    // No symbol, no grouping separator: `<input type="number">` rejects both and
    // comes up empty rather than complaining.
    expect(minorToInput(1_234_56, "AUD")).toBe("1234.56");
    expect(minorToInput(1000, "JPY")).toBe("1000");
  });

  it("round-trips with parseMinor", () => {
    for (const [minor, currency] of [
      [1250, "AUD"],
      [1000, "JPY"],
      [1000, "KWD"],
    ] as const) {
      expect(parseMinor(minorToInput(minor, currency), currency)).toBe(minor);
    }
  });
});

describe("formatMinorPair", () => {
  afterEach(() => {
    __resetMoneyFormatters();
    vi.restoreAllMocks();
  });

  it("returns one line when the gift is already in the primary currency", () => {
    const pair = formatMinorPair({ minor: 10_000, currency: "AUD" }, null);
    expect(pair.given).toMatch(/100/);
    expect(pair.primary).toBeNull();
  });

  it("returns both lines when the gift arrived in another currency", () => {
    // The as-given amount is the primary visual; the primary-currency equivalent
    // is the supporting line. Both are formatted in their OWN currency.
    const pair = formatMinorPair(
      { minor: 5_000, currency: "GBP" },
      { minor: 9_700, currency: "AUD" },
    );
    expect(pair.given).toMatch(/£|GBP/);
    expect(pair.given).toMatch(/\b50[.,]00\b/);
    expect(pair.primary).toMatch(/\b97[.,]00\b/);
  });

  it("suppresses a redundant second line when the snapshot matches the given currency", () => {
    // A webhook can legitimately write a same-currency snapshot; repeating the
    // figure underneath itself reads as a conversion that did not happen.
    const pair = formatMinorPair(
      { minor: 5_000, currency: "AUD" },
      { minor: 5_000, currency: "AUD" },
    );
    expect(pair.primary).toBeNull();
  });

  it("never re-derives a rate — it formats exactly the two amounts it is given", () => {
    // Rates are snapshotted per gift at charge time. If this function ever
    // converted, a gift log would quietly re-value itself as rates moved. Feed it
    // a deliberately absurd pair: it must render both verbatim.
    const pair = formatMinorPair(
      { minor: 100, currency: "GBP" },
      { minor: 999_900, currency: "AUD" },
    );
    expect(pair.given).toMatch(/\b1[.,]00\b/);
    expect(pair.primary).toMatch(/9[,. ]?999/);
  });
});
