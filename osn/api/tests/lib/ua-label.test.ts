import { describe, expect, it } from "vitest";

import { deriveUaLabel } from "../../src/lib/ua-label";

describe("deriveUaLabel", () => {
  it("handles the big four browser/OS combos", () => {
    expect(
      deriveUaLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS");
    expect(deriveUaLabel("Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/118.0")).toBe(
      "Firefox on Windows",
    );
    expect(deriveUaLabel("Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36")).toBe(
      "Chrome on Linux",
    );
    expect(deriveUaLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/118.0.0.0 Edg/118.0.2088.76")).toBe(
      "Edge on Windows",
    );
  });

  it("handles mobile UAs", () => {
    expect(
      deriveUaLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(
      deriveUaLabel(
        "Mozilla/5.0 (Linux; Android 13; SM-S918B) Chrome/118.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
  });

  it("falls back for empty / unknown UAs", () => {
    expect(deriveUaLabel(undefined)).toBeNull();
    expect(deriveUaLabel(null)).toBeNull();
    expect(deriveUaLabel("")).toBeNull();
    expect(deriveUaLabel("curl/8.4.0")).toBe("Unknown device");
  });
});
