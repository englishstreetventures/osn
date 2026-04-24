import { describe, it, expect } from "vitest";

import { renderTemplate, type EmailTemplate } from "../src/templates";

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

  it("renders every declared template without throwing", () => {
    const templates: readonly EmailTemplate[] = [
      "otp-registration",
      "otp-step-up",
      "otp-email-change",
      "recovery-generated",
      "recovery-consumed",
      "passkey-added",
      "passkey-removed",
    ];
    for (const t of templates) {
      const data = t.startsWith("otp-") ? { code: "000000", ttlMinutes: 10 } : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = renderTemplate(t, data as any);
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(0);
      expect(out.html.length).toBeGreaterThan(0);
    }
  });
});
