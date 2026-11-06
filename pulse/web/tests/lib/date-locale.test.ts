import { describe, expect, it } from "vitest";

import { negotiateDateLocale } from "../../src/lib/date-locale";

describe("negotiateDateLocale", () => {
  it("takes the first tag the runtime can format dates in", () => {
    expect(negotiateDateLocale("de-DE,de;q=0.9,en;q=0.8")).toBe("de-DE");
  });

  it("orders by q, not by position", () => {
    expect(negotiateDateLocale("en;q=0.5, fr-FR;q=0.9")).toBe("fr-FR");
  });

  it("falls back to en with no header, an empty one, or only a wildcard", () => {
    expect(negotiateDateLocale(null)).toBe("en");
    expect(negotiateDateLocale("")).toBe("en");
    expect(negotiateDateLocale("*")).toBe("en");
  });

  it("skips a tag that is not a valid language tag rather than throwing", () => {
    expect(negotiateDateLocale('"><script>,x-;;,ja-JP')).toBe("ja-JP");
    expect(negotiateDateLocale("not a tag")).toBe("en");
  });

  it("skips a tag the reader refused with q=0, or a malformed q", () => {
    expect(negotiateDateLocale("fr;q=0, it;q=abc, es;q=0.3")).toBe("es");
  });

  it("reads only the first tags of an overlong header", () => {
    const header = `${Array.from({ length: 500 }, () => "zz-ZZ-invalid-").join(",")},de`;
    expect(negotiateDateLocale(header)).toBe("en");
  });
});
