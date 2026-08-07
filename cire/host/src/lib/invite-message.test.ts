// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

// Pin the guest-site origin so the asserted message is deterministic.
vi.mock("./osn", () => ({ CIRE_WEB_URL: "https://guests.test" }));

import { buildInviteMessage } from "./invite-message";

describe("buildInviteMessage", () => {
  it("produces the 3-line default shape (default prose, then URL, then code)", () => {
    const message = buildInviteMessage(
      "Nadia & Sam",
      "SHARMA-WIDGET-AB3K9-X7QPM",
      "nadia-sam-abc123",
    );
    expect(message).toBe(
      "You're invited to Nadia & Sam! View your invitation and RSVP below.\n" +
        "https://guests.test/nadia-sam-abc123\n" +
        "SHARMA-WIDGET-AB3K9-X7QPM",
    );
    // Exactly three lines.
    expect(message.split("\n")).toHaveLength(3);
  });

  it("links to the wedding's PATH on the SSR'd guest site (slug in the path)", () => {
    const message = buildInviteMessage(
      "Nadia & Sam",
      "SHARMA-WIDGET-AB3K9-X7QPM",
      "nadia-sam-abc123",
    );
    const lines = message.split("\n");
    // Line 2 is the link, carrying the slug in the PATH — the guest site is
    // path-routed, so a bare-origin link would open the primary wedding, not this
    // one.
    expect(lines[1]).toBe("https://guests.test/nadia-sam-abc123");
    // Line 3 is the family's claim code.
    expect(lines[2]).toBe("SHARMA-WIDGET-AB3K9-X7QPM");
  });

  it("replaces line 1 with the host's custom message, keeping the URL + code", () => {
    const message = buildInviteMessage(
      "Nadia & Sam",
      "SHARMA-WIDGET-AB3K9-X7QPM",
      "nadia-sam-abc123",
      "Come celebrate with us in Goa!",
    );
    const lines = message.split("\n");
    expect(lines[0]).toBe("Come celebrate with us in Goa!");
    expect(lines[1]).toBe("https://guests.test/nadia-sam-abc123");
    expect(lines[2]).toBe("SHARMA-WIDGET-AB3K9-X7QPM");
    // The default prose must NOT appear when a custom message is set.
    expect(message).not.toContain("View your invitation and RSVP below");
  });

  it("falls back to the default prose for a blank/whitespace custom message", () => {
    const whitespace = buildInviteMessage("X", "CODE-1", "slug", "   \n  ");
    const empty = buildInviteMessage("X", "CODE-1", "slug", "");
    const nul = buildInviteMessage("X", "CODE-1", "slug", null);
    for (const message of [whitespace, empty, nul]) {
      expect(message.split("\n")[0]).toBe(
        "You're invited to X! View your invitation and RSVP below.",
      );
    }
  });

  it("URL-encodes a slug with unusual characters", () => {
    const message = buildInviteMessage("X", "CODE-1", "a b/c");
    expect(message.split("\n")[1]).toBe("https://guests.test/a%20b%2Fc");
  });
});
