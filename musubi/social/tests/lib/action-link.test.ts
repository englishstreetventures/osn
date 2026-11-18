/**
 * Which app-supplied links Musubi's deletion flow follows. Read by whoever
 * changes `followableLink` (`src/lib/account-deletion.ts`) or the open-action
 * card that draws the link.
 */
import { describe, expect, it } from "vitest";

import { followableLink } from "../../src/lib/account-deletion";

describe("followableLink", () => {
  it("follows https anywhere, and http only to this machine", () => {
    // The local and E2E stacks serve every app over plain HTTP on loopback;
    // osn-api forwards no http link from a deployed tier.
    for (const link of [
      "https://host.cireweddings.com/#/w/wed_1/settings/export",
      "http://localhost:4322/#/w/wed_1/settings/export",
      "http://127.0.0.1:4322/",
    ]) {
      expect(followableLink(link)).toBe(link);
    }
  });

  it("refuses http to any other host, other schemes, and what is not a URL", () => {
    // Red on a prefix check: `http://localhost.evil.example` starts like a
    // loopback link and is not one.
    for (const link of [
      "http://localhost.evil.example/",
      "http://example.com/",
      "javascript:alert(1)",
      "not a link",
      null,
    ]) {
      expect(followableLink(link)).toBeNull();
    }
  });
});
