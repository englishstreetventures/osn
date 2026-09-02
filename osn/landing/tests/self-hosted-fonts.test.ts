import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The faces are self-hosted by Astro's font pipeline (`astro.config.mjs`,
 * `fontProviders.google()`), so nothing on this site may reach
 * fonts.googleapis.com or fonts.gstatic.com — not the document head, and not
 * the CSP that would have to allow it.
 *
 * This is asserted rather than assumed because the failure is silent: a
 * re-added `<link>` still renders correctly in dev, and the only visible
 * symptom is a third-party request that transmits every visitor's IP and
 * user-agent to Google LLC (US) with no consent gate in front of it
 * (tracker #388).
 */
const pkgRoot = join(import.meta.dirname, "..");
const layoutDir = join(pkgRoot, "src", "layouts");

describe("self-hosted fonts", () => {
  const csp = readFileSync(join(pkgRoot, "public", "_headers"), "utf8")
    .split("\n")
    .find((line) => line.trim().startsWith("Content-Security-Policy:"));

  it("has a Content-Security-Policy to check", () => {
    expect(csp).toBeDefined();
  });

  it("allows fonts from our own origin only", () => {
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("fonts.gstatic.com");
    expect(csp).not.toContain("fonts.googleapis.com");
  });

  it.each(readdirSync(layoutDir).filter((f) => f.endsWith(".astro")))(
    "%s links no Google Fonts stylesheet",
    (file) => {
      const source = readFileSync(join(layoutDir, file), "utf8");
      expect(source).not.toContain("fonts.googleapis.com");
      expect(source).not.toContain("fonts.gstatic.com");
    },
  );
});
