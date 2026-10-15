import { describe, it, expect } from "vitest";

import { renderTemplate } from "../src/templates";
import type { RegistryGiftSummaryData } from "../src/templates/gift-summary";

/**
 * Tests for the `registry-gift-summary` template.
 *
 * Three things are pinned here. The counts, the totals and each money gift have
 * to survive into both bodies, because this email IS the couple's record once
 * cire has deleted the detail. Each total has to say which gifts it covers, so
 * a count never sits beside a total that adds fewer gifts. And the copy has to
 * keep saying who gave and what they wrote are gone: the template docstring
 * rules out "archived", "cold storage" and "contact support" precisely because
 * each would tell a couple something is still there to ask for.
 */

const base: RegistryGiftSummaryData = {
  weddingName: "Ama & Jonah",
  finalEventOn: "2025-05-10",
  sweptOn: "2026-05-11",
  giftCount: 2,
  giftCurrency: "AUD",
  giftTotals: [{ currency: "AUD", total: "A$1,450.00", count: 2 }],
  gifts: [
    { on: "2025-05-11", amount: "A$1,000.00", otherCurrency: null },
    { on: "2025-05-12", amount: "A$450.00", otherCurrency: null },
  ],
  giftsUnlisted: 0,
  listPurchased: 5,
  listReserved: 3,
};

/** Five gifts: four in the couple's currency, one given before they changed it. */
const mixed: RegistryGiftSummaryData = {
  ...base,
  giftCount: 5,
  giftTotals: [
    { currency: "AUD", total: "A$1,134.50", count: 4 },
    { currency: "USD", total: "US$50.00", count: 1 },
  ],
  gifts: [
    { on: "2025-03-02", amount: "US$50.00", otherCurrency: "USD" },
    { on: "2025-05-11", amount: "A$500.00", otherCurrency: null },
  ],
  giftsUnlisted: 3,
};

describe("registry-gift-summary", () => {
  it("prints the money count and total in both bodies", () => {
    const out = renderTemplate("registry-gift-summary", base);

    expect(out.subject).toContain("Ama & Jonah");
    for (const body of [out.text, out.html]) {
      expect(body).toContain("Money gifts: 2, totalling A$1,450.00");
    }
    // The list counts ride alongside, and matter for the same reason.
    expect(out.text).toContain("5 bought, 3 reserved");
    expect(out.html).toContain("5 bought, 3 reserved");
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("lists each money gift by its day, in both bodies", () => {
    const out = renderTemplate("registry-gift-summary", base);
    for (const body of [out.text, out.html]) {
      expect(body).toContain("2025-05-11");
      expect(body).toContain("A$1,000.00");
      expect(body).toContain("2025-05-12");
      expect(body).toContain("A$450.00");
    }
    // A plain list: nothing the couple has to click open to read.
    expect(out.html).not.toContain("<details");
  });

  it("puts each currency's count with its own total, never one count beside a smaller total", () => {
    const out = renderTemplate("registry-gift-summary", mixed);
    for (const body of [out.text, out.html]) {
      expect(body).toContain(
        "Money gifts: 5 — 4 in AUD, totalling A$1,134.50; 1 in USD, totalling US$50.00",
      );
      expect(body).not.toContain("Money gifts: 5, totalling");
    }
  });

  it("says a gift in another currency is outside the couple's total, in smaller text beneath", () => {
    const out = renderTemplate("registry-gift-summary", mixed);
    expect(out.text).toContain("Given in USD — outside the AUD total");
    expect(out.html).toMatch(
      /US\$50\.00<br><span style="font-size:13px;color:#666">Given in USD — outside the AUD total<\/span>/,
    );
    // The gift in the couple's own currency carries no such line.
    expect(out.html).toMatch(/A\$500\.00<\/li>/);
  });

  it("drops the comparison when no gift came in the couple's currency", () => {
    const out = renderTemplate("registry-gift-summary", {
      ...base,
      giftCount: 1,
      giftTotals: [{ currency: "USD", total: "US$50.00", count: 1 }],
      gifts: [{ on: "2025-03-02", amount: "US$50.00", otherCurrency: "USD" }],
    });
    expect(out.text).toContain("Money gifts: 1 — 1 in USD, totalling US$50.00");
    expect(out.text).toContain("Given in USD");
    expect(out.text).not.toContain("outside the AUD total");
  });

  it("names a total without a count by its currency alone", () => {
    // A summary kept before counts were recorded has totals but no counts.
    const out = renderTemplate("registry-gift-summary", {
      ...mixed,
      giftTotals: [
        { currency: "AUD", total: "A$1,134.50", count: null },
        { currency: "USD", total: "US$50.00", count: null },
      ],
    });
    expect(out.text).toContain(
      "Money gifts: 5 — in AUD, totalling A$1,134.50; in USD, totalling US$50.00",
    );
  });

  it("says how many gifts are counted but not listed one by one", () => {
    const out = renderTemplate("registry-gift-summary", mixed);
    for (const body of [out.text, out.html]) {
      expect(body).toContain("And 3 more money gifts, counted above but not listed one by one.");
    }
    const one = renderTemplate("registry-gift-summary", { ...mixed, giftsUnlisted: 1 });
    expect(one.text).toContain("And 1 more money gift, counted above but not listed one by one.");
    expect(renderTemplate("registry-gift-summary", base).text).not.toContain("not listed");
  });

  it("says the gifts are counted but not listed, with no empty list, when none is listed", () => {
    // A record kept before gifts were listed: a count and totals, no list.
    const out = renderTemplate("registry-gift-summary", { ...mixed, gifts: [], giftsUnlisted: 5 });
    for (const body of [out.text, out.html]) {
      expect(body).toContain("5 money gifts are counted above but not listed one by one.");
      expect(body).not.toContain("Each money gift");
      expect(body).not.toContain("And 5 more");
    }
    const one = renderTemplate("registry-gift-summary", {
      ...base,
      giftCount: 1,
      gifts: [],
      giftsUnlisted: 1,
    });
    expect(one.text).toContain("1 money gift is counted above but not listed one by one.");
  });

  it("says 'none' when no money gift settled", () => {
    const out = renderTemplate("registry-gift-summary", {
      ...base,
      giftCount: 0,
      giftTotals: [],
      gifts: [],
    });
    expect(out.text).toContain("Money gifts: none");
    expect(out.html).toContain("Money gifts: none");
    expect(out.text).not.toContain("totalling");
    expect(out.text).not.toContain("Each money gift");
  });

  it("escapes the wedding name and every amount in HTML and leaves them raw in text", () => {
    const out = renderTemplate("registry-gift-summary", {
      ...base,
      weddingName: "<script>Ben & Jo",
      gifts: [{ on: "2025-05-11", amount: "<b>A$1</b>", otherCurrency: "<i>" }],
    });

    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<b>");
    expect(out.html).not.toContain("<i>");
    expect(out.html).toContain("&lt;script&gt;Ben &amp; Jo");
    // Plain text has no markup to escape into, and mangling the name there
    // would only make the record harder to read.
    expect(out.text).toContain("<script>Ben & Jo");
  });

  it("says who gave and what they wrote are unrecoverable, and never suggests otherwise", () => {
    const out = renderTemplate("registry-gift-summary", base);

    for (const body of [out.text, out.html]) {
      expect(body).toContain("We kept the amount and the day of each money gift");
      expect(body).toContain("We have not kept a copy and we cannot get them back");
      // Each of these would tell the couple something still exists to ask for.
      const lowered = body.toLowerCase();
      expect(lowered).not.toContain("archived");
      expect(lowered).not.toContain("cold storage");
      expect(lowered).not.toContain("contact support");
    }
  });

  it("stays under the size at which Gmail clips a message, at a full list", () => {
    // The kept record lists at most 200 gifts (`GIFT_SUMMARY_MAX_LISTED` in
    // cire-api). Gmail clips HTML past about 102 KB, and a clipped record hides
    // its own end.
    const gifts = Array.from({ length: 200 }, (_, i) => ({
      on: "2025-05-11",
      amount: `US$${(100_000 + i).toLocaleString("en-US")}.00`,
      otherCurrency: "USD",
    }));
    const out = renderTemplate("registry-gift-summary", {
      ...mixed,
      weddingName: "W".repeat(200),
      gifts,
      giftCount: 200,
    });
    expect(new TextEncoder().encode(out.html).length).toBeLessThan(102_000);
  });
});
