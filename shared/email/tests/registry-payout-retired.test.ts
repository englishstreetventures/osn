import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";
import type { RegistryPayoutRetiredData } from "../src/templates";

/**
 * The email a wedding's owners get when an owner retires the Stripe account
 * money gifts are paid into. It must say who did it, whom they asked to
 * connect the next account, that guests cannot give money until an owner
 * does, and where to do that. The wedding's name and the people's names are
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
  it("tells another owner who disconnected it, whom they asked to connect the next, and what guests cannot do", () => {
    const out = renderTemplate("registry-payout-retired", data);
    expect(out.subject).toBe("Money gifts on Ama & Jonah need a new Stripe account");
    expect(out.text).toContain(
      "Ama Mensah (@ama) disconnected their Stripe account from Ama & Jonah and asked @jonah to connect the next one.",
    );
    expect(out.text).toContain("Guests cannot give money until an owner connects a Stripe account");
    expect(out.text).toContain("Registry, then Settings, under Money gifts");
    expect(out.text).toContain(data.moneyGiftsUrl);
  });

  it("speaks to the owner asked to connect the next account", () => {
    const out = renderTemplate("registry-payout-retired", { ...data, audience: "named" });
    expect(out.text).toContain("and asked you to connect the next one.");
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

  it("tells everyone else that gifts already given stay where they were paid, not that they are theirs", () => {
    for (const audience of ["owner", "named"] as const) {
      const out = renderTemplate("registry-payout-retired", { ...data, audience });
      expect(out.text).toContain(
        "Gifts already given stay in the Stripe account they were paid into",
      );
      expect(out.text).not.toContain("Gifts already given stay in your Stripe account");
    }
  });

  it("names no holder for an account no current owner held", () => {
    const out = renderTemplate("registry-payout-retired", {
      ...data,
      reason: "holder_absent",
      namedName: null,
      holderName: null,
    });
    expect(out.text).toContain(
      "Ama Mensah (@ama) disconnected the Stripe account for money gifts on Ama & Jonah. None of the wedding's owners had connected it.",
    );
  });

  it("escapes the names in the HTML and keeps the subject on one line", () => {
    const out = renderTemplate("registry-payout-retired", {
      ...data,
      weddingName: "A\nB & <C>",
      actorName: "<b>Ama</b>",
      namedName: '"x" & <y>\'',
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).not.toContain("<C>");
    expect(out.html).not.toContain("<b>Ama</b>");
    expect(out.html).not.toContain("<y>");
    expect(out.html).toContain("B &amp; &lt;C&gt;");
  });

  it("labels its one button with the page's own verb, and prints the link under it", () => {
    const out = renderTemplate("registry-payout-retired", data);
    expect(out.html).toMatch(/>Connect a Stripe account<\/a>/);
    expect(out.html).toContain(
      `<p style="color:#666;font-size:14px;word-break:break-all">${data.moneyGiftsUrl}</p>`,
    );
  });
});
