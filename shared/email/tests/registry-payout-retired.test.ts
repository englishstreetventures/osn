import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";
import type { RegistryPayoutRetiredData } from "../src/templates";

/**
 * The email a wedding's owners get when an owner retires the Stripe account
 * money gifts are paid into. It must say who did it, whom money gifts were
 * handed to, that guests cannot give money until an owner connects an
 * account, and where to do that. The wedding's name and the people's names are
 * written by owners, so they are escaped and kept off a second subject line.
 */
const data: RegistryPayoutRetiredData = {
  weddingName: "Ama & Jonah",
  actorName: "Ama Mensah (@ama)",
  namedName: "@jonah",
  holderName: null,
  reason: "handed_over",
  audience: "owner",
  moneyGiftsUrl: "https://host.example.test/#/w/wed_1/registry/settings",
};

describe("registry-payout-retired", () => {
  it("tells another owner who handed money gifts to whom, and what guests cannot do", () => {
    const out = renderTemplate("registry-payout-retired", data);
    expect(out.text).toContain(
      "Ama Mensah (@ama) disconnected their Stripe account from Ama & Jonah and handed money gifts to @jonah.",
    );
    expect(out.text).toContain("Guests cannot give money until an owner connects a Stripe account");
    expect(out.text).toContain(data.moneyGiftsUrl);
  });

  it("speaks to the owner money gifts were handed to", () => {
    const out = renderTemplate("registry-payout-retired", { ...data, audience: "named" });
    expect(out.text).toContain("and handed money gifts to you.");
    expect(out.text).toContain("Guests cannot give money until you connect a Stripe account");
  });

  it("tells the holder whose account another owner replaced that their gifts stay with them", () => {
    const out = renderTemplate("registry-payout-retired", {
      ...data,
      reason: "replaced",
      namedName: null,
      holderName: "@jonah",
      audience: "holder",
    });
    expect(out.text).toContain(
      "Ama Mensah (@ama) disconnected the Stripe account you connected to Ama & Jonah.",
    );
    expect(out.text).toContain("Gifts already given stay in your Stripe account");
  });

  it("names no holder for an account no current owner held", () => {
    const out = renderTemplate("registry-payout-retired", {
      ...data,
      reason: "holder_absent",
      namedName: null,
      holderName: null,
    });
    expect(out.text).toContain("No current owner of the wedding had connected it.");
  });

  it("escapes the names in the HTML, keeps the subject on one line, and draws the one button", () => {
    const out = renderTemplate("registry-payout-retired", {
      ...data,
      weddingName: "A\nB & <C>",
      actorName: "<b>Ama</b>",
      namedName: '"x" & <y>',
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).not.toContain("<C>");
    expect(out.html).not.toContain("<b>Ama</b>");
    expect(out.html).not.toContain("<y>");
    expect(out.html).toContain("B &amp; &lt;C&gt;");
    expect(out.html).toContain(
      'style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px"',
    );
  });
});
