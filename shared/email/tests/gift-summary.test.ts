import { describe, it, expect } from "vitest";

import { renderTemplate } from "../src/templates";

/**
 * Tests for the `registry-gift-summary` template.
 *
 * Two things are pinned here. The counts have to survive into both bodies,
 * because this email IS the couple's record once cire has deleted the detail.
 * And the copy has to keep saying the detail is gone: the template docstring
 * rules out "archived", "cold storage" and "contact support" precisely because
 * each would tell a couple something is still there to ask for.
 */

const base = {
  weddingName: "Ama & Jonah",
  finalEventOn: "2025-05-10",
  sweptOn: "2026-05-11",
  giftCount: 12,
  giftTotal: "A$1,450.00",
  listPurchased: 5,
  listReserved: 3,
};

describe("registry-gift-summary", () => {
  it("prints the money count and total in both bodies", () => {
    const out = renderTemplate("registry-gift-summary", base);

    expect(out.subject).toContain("Ama & Jonah");
    for (const body of [out.text, out.html]) {
      expect(body).toContain("12");
      expect(body).toContain("A$1,450.00");
    }
    // The list counts ride alongside, and matter for the same reason.
    expect(out.text).toContain("5 bought, 3 reserved");
    expect(out.html).toContain("5 bought, 3 reserved");
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("says 'none' when no money gift settled", () => {
    const noTotal = renderTemplate("registry-gift-summary", { ...base, giftTotal: null });
    expect(noTotal.text).toContain("Money gifts: none");
    expect(noTotal.html).toContain("Money gifts: none");
    expect(noTotal.text).not.toContain("totalling");

    // A count of zero reaches the same line by the other half of the guard.
    const noCount = renderTemplate("registry-gift-summary", { ...base, giftCount: 0 });
    expect(noCount.text).toContain("Money gifts: none");
    expect(noCount.html).toContain("Money gifts: none");
    expect(noCount.text).not.toContain("totalling");
  });

  it("escapes the wedding name in HTML and leaves it raw in text", () => {
    const out = renderTemplate("registry-gift-summary", {
      ...base,
      weddingName: "<script>Ben & Jo",
    });

    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;Ben &amp; Jo");
    // Plain text has no markup to escape into, and mangling the name there
    // would only make the record harder to read.
    expect(out.text).toContain("<script>Ben & Jo");
  });

  it("says the detail is unrecoverable, and never suggests otherwise", () => {
    const out = renderTemplate("registry-gift-summary", base);

    for (const body of [out.text, out.html]) {
      expect(body).toContain("We have not kept a copy and we cannot get it back");
      // Each of these would tell the couple something still exists to ask for.
      const lowered = body.toLowerCase();
      expect(lowered).not.toContain("archived");
      expect(lowered).not.toContain("cold storage");
      expect(lowered).not.toContain("contact support");
    }
  });
});
