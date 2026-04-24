// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";

import { formatPrice } from "../../src/lib/formatPrice";

describe("formatPrice", () => {
  it("returns 'Free' when amount is null", () => {
    expect(formatPrice(null, "USD")).toBe("Free");
  });

  it("returns 'Free' when amount is undefined", () => {
    expect(formatPrice(undefined, "USD")).toBe("Free");
  });

  it("returns 'Free' when amount is 0 (explicit free marker)", () => {
    expect(formatPrice(0, "USD")).toBe("Free");
  });

  it("returns 'Free' when currency is null", () => {
    expect(formatPrice(1850, null)).toBe("Free");
  });

  it("returns 'Free' when currency is undefined", () => {
    expect(formatPrice(1850, undefined)).toBe("Free");
  });

  it("formats USD minor units with 2 decimal places", () => {
    expect(formatPrice(1850, "USD", "en-US")).toBe("$18.50");
  });

  it("formats JPY as zero-decimal", () => {
    // Intl uses a narrow no-break space (U+00A0) between symbol and digits for
    // JPY in en-US — match permissively on the number + symbol.
    const out = formatPrice(500, "JPY", "en-US");
    expect(out).toMatch(/500/);
    expect(out).toMatch(/¥/);
    expect(out).not.toMatch(/500\./); // no decimals for JPY
  });

  it("formats GBP with pound symbol", () => {
    expect(formatPrice(1500, "GBP", "en-GB")).toBe("£15.00");
  });

  it("uses 2dp exponent for unknown currencies (defensive fallback)", () => {
    // "ZZZ" is a real ISO-4217 reserved code accepted by Intl. The helper's
    // EXPONENT table doesn't list it, so it should fall back to 2dp.
    const out = formatPrice(1000, "ZZZ", "en-US");
    // Either Intl renders it (with the code as the symbol) or the catch
    // block fires — both produce "10.00" in the string.
    expect(out).toMatch(/10\.00/);
  });

  it("falls back to '<currency> <major>' when Intl throws", () => {
    // "XX" is <3 chars and guaranteed to throw in Intl.NumberFormat.
    expect(formatPrice(1850, "XX")).toBe("XX 18.50");
  });

  it("returns stable output across repeated calls (formatter cache)", () => {
    const a = formatPrice(1850, "USD", "en-US");
    const b = formatPrice(1850, "USD", "en-US");
    const c = formatPrice(2500, "USD", "en-US");
    expect(a).toBe(b);
    expect(a).toBe("$18.50");
    expect(c).toBe("$25.00");
  });
});
