import { describe, expect, it } from "vitest";

import { coerceShareSource, isShareSource, withShareSource } from "../../src/lib/shareSource";

describe("isShareSource", () => {
  it("accepts every canonical source", () => {
    for (const source of [
      "instagram",
      "facebook",
      "tiktok",
      "x",
      "whatsapp",
      "copy_link",
      "other",
    ]) {
      expect(isShareSource(source)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isShareSource("myspace")).toBe(false);
    expect(isShareSource("")).toBe(false);
    expect(isShareSource(null)).toBe(false);
    expect(isShareSource(undefined)).toBe(false);
    expect(isShareSource(42)).toBe(false);
  });
});

describe("coerceShareSource", () => {
  it("returns null for null/undefined/empty", () => {
    expect(coerceShareSource(null)).toBeNull();
    expect(coerceShareSource(undefined)).toBeNull();
    expect(coerceShareSource("")).toBeNull();
  });

  it("passes known values through", () => {
    expect(coerceShareSource("tiktok")).toBe("tiktok");
    expect(coerceShareSource("whatsapp")).toBe("whatsapp");
  });

  it("buckets unknown values into 'other' so attribution still records", () => {
    expect(coerceShareSource("myspace")).toBe("other");
    expect(coerceShareSource("UNKNOWN")).toBe("other");
  });

  it("uses the first element when given an array (Solid router shape)", () => {
    expect(coerceShareSource(["facebook", "tiktok"])).toBe("facebook");
    expect(coerceShareSource([])).toBeNull();
  });
});

describe("withShareSource", () => {
  it("injects source into a clean URL", () => {
    const out = withShareSource("https://pulse.app/events/evt_1", "instagram");
    expect(out).toBe("https://pulse.app/events/evt_1?source=instagram");
  });

  it("replaces an existing source param so chained shares don't accumulate", () => {
    const out = withShareSource("https://pulse.app/events/evt_1?source=tiktok", "instagram");
    expect(out).toBe("https://pulse.app/events/evt_1?source=instagram");
  });

  it("preserves unrelated query params", () => {
    const out = withShareSource("https://pulse.app/events/evt_1?utm=launch&ref=foo", "facebook");
    const parsed = new URL(out);
    expect(parsed.searchParams.get("source")).toBe("facebook");
    expect(parsed.searchParams.get("utm")).toBe("launch");
    expect(parsed.searchParams.get("ref")).toBe("foo");
  });

  it("returns the input unchanged when the URL is unparseable", () => {
    expect(withShareSource("not a url", "x")).toBe("not a url");
  });
});
