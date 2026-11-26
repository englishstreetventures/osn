import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";

/**
 * The email a wedding's remaining owners get when the owner who connected its
 * Stripe account deletes their account. The wedding's name is written by an
 * owner, so it is escaped and kept off a second subject line.
 */
describe("registry-payout-holder-erased", () => {
  it("escapes the wedding's name in the HTML and keeps the subject on one line", () => {
    const out = renderTemplate("registry-payout-holder-erased", {
      weddingName: "A\nB & <C>",
      moneyGiftsUrl: 'https://host.example.test/#/w/"x"<y>/registry/settings',
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).not.toContain("<C>");
    expect(out.html).not.toContain("<y>");
    expect(out.html).toContain("B &amp; &lt;C&gt;");
    expect(out.html).toContain("&quot;x&quot;&lt;y&gt;");
  });
});
