import { describe, it, expect } from "vitest";

import {
  renderTemplate,
  type AccountEmailTemplate,
  type EmailTemplate,
  type EmailTemplateData,
} from "../src/templates";

describe("renderTemplate", () => {
  it("renders registration OTP with code + TTL", () => {
    const out = renderTemplate("otp-registration", {
      code: "000000",
      ttlMinutes: 10,
      instanceName: "Musubi",
    });
    expect(out.subject).toMatchInlineSnapshot(`"Verify your Musubi email"`);
    expect(out.text).toContain("000000");
    expect(out.text).toContain("10 minutes");
    expect(out.html).toContain("000000");
    expect(out.html).toContain("10 minutes");
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("renders email-change OTP with somebody-asked framing", () => {
    const out = renderTemplate("otp-email-change", {
      code: "987654",
      ttlMinutes: 10,
      instanceName: "Musubi",
    });
    expect(out.subject).toBe("Confirm your new Musubi email");
    // The "not-you" framing is load-bearing for phishing resistance.
    expect(out.text).toContain("If that wasn't you");
  });

  it("recovery templates never include codes", () => {
    const gen = renderTemplate("recovery-generated", { instanceName: "Musubi" });
    const used = renderTemplate("recovery-consumed", { instanceName: "Musubi" });
    for (const out of [gen, used]) {
      expect(out.text).not.toMatch(/\b\d{4,}\b/);
      expect(out.html).not.toMatch(/\b\d{4,}\b/);
    }
  });

  it("passkey templates never include codes", () => {
    const added = renderTemplate("passkey-added", { instanceName: "Musubi" });
    const removed = renderTemplate("passkey-removed", { instanceName: "Musubi" });
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
      instanceName: "Musubi",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
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
    "otp-registration": { code: "000000", ttlMinutes: 10, instanceName: "Musubi" },
    "otp-step-up": { code: "000000", ttlMinutes: 10, instanceName: "Musubi" },
    "otp-email-change": { code: "000000", ttlMinutes: 10, instanceName: "Musubi" },
    "recovery-generated": { instanceName: "Musubi" },
    "recovery-consumed": { instanceName: "Musubi" },
    "otp-recovery": { code: "000000", ttlMinutes: 10, instanceName: "Musubi" },
    "recovery-used": { disownUrl: "https://example.test/disown/abc", instanceName: "Musubi" },
    "totp-enrolled": { instanceName: "Musubi" },
    "totp-disabled": { instanceName: "Musubi" },
    "passkey-added": { instanceName: "Musubi" },
    "passkey-removed": { instanceName: "Musubi" },
    "cross-device-login": { instanceName: "Musubi" },
    "registry-gift-summary": {
      weddingName: "Ama & Jonah",
      finalEventOn: "2025-05-10",
      sweptOn: "2026-05-11",
      giftCount: 3,
      giftCurrency: "AUD",
      giftTotals: [{ currency: "AUD", total: "A$300.00", count: 3 }],
      gifts: [{ on: "2025-05-11", amount: "A$100.00", otherCurrency: null }],
      giftsUnlisted: 2,
      listPurchased: 1,
      listReserved: 2,
    },
    "rsvp-change-digest": {
      weddingName: "Ama & Jonah",
      households: 2,
      counts: { reply_new: 2 },
      rsvpUrl: "https://example.test/#/w/wed_1/guests/rsvps",
    },
    "vendor-claim-invite": {
      claimUrl: "https://example.test/claim/abc",
      vendorName: "Bloom & Co",
    },
    "vendor-claim-review-pending": { pending: 2, oldestWaitingDays: 3, env: "production" },
    "r2-reconcile-alert": {
      kind: "held",
      env: "production",
      bucket: "cire-sheets",
      referencingRows: 40,
      previousRows: 100,
      heldRuns: 1,
      runsLeft: 6,
    },
    "wedding-delete-started": {
      weddingName: "Ama & Jonah",
      actorName: "Ama Mensah (@ama)",
      audience: "owner",
      restoreUntil: "9 October 2026, 14:05 UTC",
      restoreDays: 7,
      portalUrl: "https://host.example.test",
    },
    "wedding-owner-change": {
      weddingName: "Ama & Jonah",
      actorName: "Ama Mensah (@ama)",
      subjectName: "@jonah",
      change: "removed",
      audience: "owner",
      self: false,
      portalUrl: "https://host.example.test",
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

/**
 * The account emails osn-api sends name the identity instance they come from,
 * and that name is the instance's to choose: an operator running their own
 * instance must not send mail that names ours. The name carries `&`, `<` and
 * `>` so the same render also proves it is escaped in the HTML part.
 */
describe("account emails name the instance passed in", () => {
  const instanceName = "Acme & <Co>";
  const accountEmails = {
    "otp-registration": { code: "000000", ttlMinutes: 10, instanceName },
    "otp-step-up": { code: "000000", ttlMinutes: 10, instanceName },
    "otp-email-change": { code: "000000", ttlMinutes: 10, instanceName },
    "otp-recovery": { code: "000000", ttlMinutes: 10, instanceName },
    "recovery-generated": { instanceName },
    "recovery-consumed": { instanceName },
    "recovery-used": { disownUrl: "https://example.test/disown/abc", instanceName },
    "passkey-added": { instanceName },
    "passkey-removed": { instanceName },
    "totp-enrolled": { instanceName },
    "totp-disabled": { instanceName },
    "cross-device-login": { instanceName },
  } satisfies { [K in AccountEmailTemplate]: EmailTemplateData<K> };

  for (const template of Object.keys(accountEmails) as AccountEmailTemplate[]) {
    it(`${template} names the instance and no fixed product`, () => {
      const out = renderTemplate(template, accountEmails[template]);
      expect(`${out.subject}\n${out.text}`).toContain(instanceName);
      for (const part of [out.subject, out.text, out.html]) {
        expect(part).not.toMatch(/\bOSN\b|Musubi/);
      }
    });

    it(`${template} escapes the instance name in its HTML`, () => {
      const out = renderTemplate(template, accountEmails[template]);
      expect(out.html).toContain("Acme &amp; &lt;Co&gt;");
      expect(out.html).not.toContain(instanceName);
    });
  }
});
