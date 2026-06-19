// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

// Pin the guest-site origin so the asserted message is deterministic.
vi.mock("./osn", () => ({ CIRE_WEB_URL: "https://guests.test" }));

import { buildInviteMessage } from "./invite-message";

describe("buildInviteMessage", () => {
  it("links to the wedding's PATH on the SSR'd guest site (slug in the path)", () => {
    const message = buildInviteMessage(
      "Nadia & Sam",
      "SHARMA-WIDGET-AB3K9-X7QPM",
      "nadia-sam-abc123",
    );
    // The link must carry the slug in the path — the guest site is path-routed,
    // so a bare-origin link would open the primary wedding, not this one.
    expect(message).toContain("https://guests.test/nadia-sam-abc123");
    // Never the bare origin without the slug path.
    expect(message).not.toContain("https://guests.test —");
    expect(message).toContain("Nadia & Sam");
    expect(message).toContain("SHARMA-WIDGET-AB3K9-X7QPM");
  });

  it("URL-encodes a slug with unusual characters", () => {
    const message = buildInviteMessage("X", "CODE-1", "a b/c");
    expect(message).toContain("https://guests.test/a%20b%2Fc");
  });
});
