import { describe, it, expect } from "vitest";

import { renderTemplate } from "../src/templates";

describe("enquiry email templates", () => {
  it("enquiry-new (claimed) omits the claim CTA and includes the message + thread url", () => {
    const r = renderTemplate("enquiry-new", {
      vendorName: "Bloom Co",
      weddingName: "Sam & Alex",
      message: "Are you free June 2027?",
      threadUrl: "https://host.example/enquiries/enq_1",
      unclaimed: false,
    });
    expect(r.subject).toContain("Sam & Alex");
    expect(r.text).toContain("Are you free June 2027?");
    expect(r.text).toContain("https://host.example/enquiries/enq_1");
    expect(r.text).not.toContain("Claim your listing");
  });

  it("enquiry-new (unclaimed) includes the claim CTA + claimUrl", () => {
    const r = renderTemplate("enquiry-new", {
      vendorName: "Bloom Co",
      weddingName: "Sam & Alex",
      message: "Hi",
      threadUrl: "https://host.example/enquiries/enq_1",
      unclaimed: true,
      claimUrl: "https://vendor.example/claim/tok_9",
    });
    expect(r.text).toContain("Claim your listing");
    expect(r.text).toContain("https://vendor.example/claim/tok_9");
  });

  it("enquiry-quote formats the amount + optional note", () => {
    const r = renderTemplate("enquiry-quote", {
      vendorName: "Bloom Co",
      amountFormatted: "$1,200.00",
      note: "Includes delivery",
      threadUrl: "https://host.example/enquiries/enq_1",
    });
    expect(r.subject).toContain("quote");
    expect(r.text).toContain("$1,200.00");
    expect(r.text).toContain("Includes delivery");
  });

  it("escapes HTML in user-supplied fields", () => {
    const r = renderTemplate("enquiry-reply", {
      recipientName: "Bloom Co",
      senderName: "Sam & Alex",
      message: "<script>alert(1)</script>",
      threadUrl: "https://host.example/enquiries/enq_1",
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});
