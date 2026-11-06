import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";

/**
 * The email a wedding's owners get when cire refunds an upgrade payment it
 * could not grant. It says the money went back and how to reach cire; it
 * carries no guest data and no reason that could expose another owner's act.
 */
describe("upgrade-refund", () => {
  const data = {
    weddingName: "Ama & <Jonah>",
    tierName: "Gold",
    amount: "A$79.00",
    contactEmail: "help@cire.example.test",
    portalUrl: "https://host.example.test",
  };

  it("says the payment was refunded in full, for which wedding and tier, and where to write", () => {
    const out = renderTemplate("upgrade-refund", data);
    expect(out.subject).toBe("Your Cire upgrade payment has been refunded");
    expect(out.text).toContain(
      "We could not upgrade Ama & <Jonah> to Gold, so we have refunded your payment of A$79.00 in full.",
    );
    expect(out.text).toContain("Questions? Write to us at help@cire.example.test.");
    expect(out.text).toContain("https://host.example.test");
    expect(out.html).toContain('href="mailto:help@cire.example.test"');
  });

  it("escapes the wedding's name in the HTML, and keeps the subject on one line", () => {
    const out = renderTemplate("upgrade-refund", { ...data, weddingName: "A\nB & <C>" });
    expect(out.html).toContain("B &amp; &lt;C&gt;");
    expect(out.html).not.toContain("<C>");
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it("reads plainly with no tier or amount to name", () => {
    const out = renderTemplate("upgrade-refund", { ...data, tierName: null, amount: null });
    expect(out.text).toContain(
      "We could not upgrade Ama & <Jonah>, so we have refunded your payment in full.",
    );
  });
});
