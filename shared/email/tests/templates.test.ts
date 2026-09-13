import { describe, it, expect } from "vitest";

import { renderTemplate, type EmailTemplate, type EmailTemplateData } from "../src/templates";

describe("renderTemplate", () => {
  it("renders registration OTP with code + TTL", () => {
    const out = renderTemplate("otp-registration", { code: "000000", ttlMinutes: 10 });
    expect(out.subject).toMatchInlineSnapshot(`"Verify your OSN email"`);
    expect(out.text).toContain("000000");
    expect(out.text).toContain("10 minutes");
    expect(out.html).toContain("000000");
    expect(out.html).toContain("10 minutes");
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("renders step-up OTP with bounded framing", () => {
    const out = renderTemplate("otp-step-up", { code: "123456", ttlMinutes: 5 });
    expect(out.subject).toBe("Confirm a sensitive action");
    expect(out.text).toContain("123456");
  });

  it("renders email-change OTP with S-L5 somebody-asked framing", () => {
    const out = renderTemplate("otp-email-change", { code: "987654", ttlMinutes: 10 });
    expect(out.subject).toBe("Confirm your new OSN email");
    // The "not-you" framing is load-bearing for phishing resistance.
    expect(out.text).toContain("If that wasn't you");
  });

  it("recovery templates never include codes", () => {
    const gen = renderTemplate("recovery-generated", {});
    const used = renderTemplate("recovery-consumed", {});
    for (const out of [gen, used]) {
      expect(out.text).not.toMatch(/\b\d{4,}\b/);
      expect(out.html).not.toMatch(/\b\d{4,}\b/);
    }
  });

  it("passkey templates never include codes", () => {
    const added = renderTemplate("passkey-added", {});
    const removed = renderTemplate("passkey-removed", {});
    for (const out of [added, removed]) {
      expect(out.text).not.toMatch(/\b\d{4,}\b/);
      expect(out.html).not.toMatch(/\b\d{4,}\b/);
    }
  });

  it("HTML-escapes template data (defence in depth)", () => {
    // OTP templates happen to accept digits-only in practice, but the
    // escape path should hold if template data ever carries markup.
    const out = renderTemplate("otp-registration", {
      code: "<script>",
      ttlMinutes: 10,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("renders boundary TTL values without crashing", () => {
    const zero = renderTemplate("otp-registration", { code: "000000", ttlMinutes: 0 });
    expect(zero.text).toContain("0 minutes");

    const fractional = renderTemplate("otp-step-up", { code: "000000", ttlMinutes: 0.5 });
    expect(fractional.text).toContain("0.5 minutes");

    const large = renderTemplate("otp-email-change", { code: "000000", ttlMinutes: 1440 });
    expect(large.text).toContain("1440 minutes");
  });

  /**
   * One fixture per template, checked against the template-to-data map. The
   * `satisfies` is the point: adding a template to `EmailTemplate` without
   * adding data here is a type error, so no future template can slip past
   * this test the way `registry-gift-summary` and the enquiry ones did while
   * the list was written out by hand.
   */
  const fixtures = {
    "enquiry-new": {
      vendorName: "Bloom & Co",
      weddingName: "Ama & Jonah",
      message: "Are you free on the 10th?",
      threadUrl: "https://example.test/thread/1",
      unclaimed: false,
    },
    "enquiry-reply": {
      recipientName: "Ama",
      senderName: "Bloom & Co",
      message: "We are.",
      threadUrl: "https://example.test/thread/1",
    },
    "enquiry-quote": {
      vendorName: "Bloom & Co",
      amountFormatted: "A$1,200.00",
      threadUrl: "https://example.test/thread/1",
    },
    "otp-registration": { code: "000000", ttlMinutes: 10 },
    "otp-step-up": { code: "000000", ttlMinutes: 10 },
    "otp-email-change": { code: "000000", ttlMinutes: 10 },
    "recovery-generated": {},
    "recovery-consumed": {},
    "otp-recovery": { code: "000000", ttlMinutes: 10 },
    "recovery-used": { disownUrl: "https://example.test/disown/abc" },
    "totp-enrolled": {},
    "totp-disabled": {},
    "passkey-added": {},
    "passkey-removed": {},
    "cross-device-login": {},
    "registry-gift-summary": {
      weddingName: "Ama & Jonah",
      finalEventOn: "2025-05-10",
      sweptOn: "2026-05-11",
      giftCount: 3,
      giftTotal: "A$300.00",
      listPurchased: 1,
      listReserved: 2,
    },
    "vendor-claim-invite": {
      claimUrl: "https://example.test/claim/abc",
      vendorName: "Bloom & Co",
    },
  } satisfies { [K in EmailTemplate]: EmailTemplateData<K> };

  it("renders every declared template without throwing", () => {
    const templates = Object.keys(fixtures) as readonly EmailTemplate[];
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      const out = renderTemplate(template, fixtures[template]);
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(0);
      expect(out.html.length).toBeGreaterThan(0);
    }
  });
});
