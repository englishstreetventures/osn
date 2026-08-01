import { describe, expect, it } from "vitest";

import {
  assertCorsOriginsConfigured,
  IOS_WEBVIEW_ORIGIN,
  LOCAL_DEV_CORS_ORIGINS,
  resolveCorsOrigins,
} from "../../src/lib/cors-config";

describe("resolveCorsOrigins", () => {
  it("parses a comma-separated allowlist from PULSE_CORS_ORIGIN", () => {
    const origins = resolveCorsOrigins(
      { PULSE_CORS_ORIGIN: "https://app.pulse.example, https://admin.pulse.example" },
      true,
    );
    expect(origins).toEqual(["https://app.pulse.example", "https://admin.pulse.example"]);
  });

  it("normalises trailing slash + casing so an operator typo still matches", () => {
    const origins = resolveCorsOrigins({ PULSE_CORS_ORIGIN: "HTTPS://App.Pulse.Example/" }, true);
    expect(origins).toEqual(["https://app.pulse.example"]);
  });

  it("falls back to the local dev origin when unset in a non-secure env", () => {
    const origins = resolveCorsOrigins({}, false);
    expect(origins).toEqual([...LOCAL_DEV_CORS_ORIGINS]);
    // Spelled out, not just `[...LOCAL_DEV_CORS_ORIGINS]` — that comparison
    // would pass even if the list were emptied.
    expect(origins).toEqual(["http://localhost:1420", "tauri://localhost"]);
  });

  it("carries the iOS webview origin through an explicit PULSE_CORS_ORIGIN", () => {
    expect(
      resolveCorsOrigins(
        { PULSE_CORS_ORIGIN: `https://app.pulse.example, ${IOS_WEBVIEW_ORIGIN}` },
        true,
      ),
    ).toContain("tauri://localhost");
  });

  it("normalises a trailing slash on the iOS webview origin", () => {
    expect(resolveCorsOrigins({ PULSE_CORS_ORIGIN: "TAURI://LocalHost/" }, true)).toEqual([
      "tauri://localhost",
    ]);
  });

  it("never allowlists a literal `null` origin", () => {
    // The N1 spike proved the iOS webview sends a real tuple origin, so
    // nothing needs `null` — and allowlisting it would admit every sandboxed
    // iframe on the web.
    expect(resolveCorsOrigins({}, false)).not.toContain("null");
    expect(resolveCorsOrigins({ PULSE_CORS_ORIGIN: IOS_WEBVIEW_ORIGIN }, true)).not.toContain(
      "null",
    );
  });

  it("returns an empty list when unset in a secure env (fail-closed input)", () => {
    expect(resolveCorsOrigins({}, true)).toEqual([]);
  });

  it("drops empty entries from a sloppy env value", () => {
    expect(resolveCorsOrigins({ PULSE_CORS_ORIGIN: "https://a.example,, " }, true)).toEqual([
      "https://a.example",
    ]);
  });
});

describe("assertCorsOriginsConfigured", () => {
  it("throws when a secure env has an empty allowlist", () => {
    expect(() => assertCorsOriginsConfigured([], true)).toThrow(/PULSE_CORS_ORIGIN must be set/);
  });

  it("does not throw when a secure env has at least one origin", () => {
    expect(() => assertCorsOriginsConfigured(["https://a.example"], true)).not.toThrow();
  });

  it("does not throw for a local env even with an empty list (dev fallback covers it)", () => {
    expect(() => assertCorsOriginsConfigured([], false)).not.toThrow();
  });
});
