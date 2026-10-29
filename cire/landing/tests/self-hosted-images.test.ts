import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The site's photograph is served from `public/images/`, so the CSP lets
 * images come from this origin and `data:` URLs and nowhere else.
 *
 * Asserted rather than assumed for the same reason as the fonts
 * (`self-hosted-fonts.test.ts`): an image from another host renders the same
 * in dev, where `astro dev` applies no `_headers`, and the only sign is a
 * request that sends every visitor's IP address and user agent to that host.
 * With `img-src` held to this origin, such an image breaks in production
 * instead of loading quietly.
 */
const csp = readFileSync(join(import.meta.dirname, "..", "public", "_headers"), "utf8")
  .split("\n")
  .find((line) => line.trim().startsWith("Content-Security-Policy:"));

describe("self-hosted images", () => {
  it("allows images from our own origin and data: URLs only", () => {
    const imgSrc = csp
      ?.split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("img-src "));
    expect(imgSrc).toBe("img-src 'self' data:");
  });
});
