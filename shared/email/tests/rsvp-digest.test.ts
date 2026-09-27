import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";

/**
 * Tests for the `rsvp-change-digest` template — cire's daily note to a
 * wedding's organisers that guests changed their RSVPs.
 *
 * It carries counts and a link, never a guest's name: the names stay in the
 * organiser portal, so no guest data travels through the mail provider.
 */

const base = {
  weddingName: "Ama & Jonah",
  households: 4,
  counts: { reply_new: 3, reply_edited: 1 },
  rsvpUrl: "https://host.example.test/#/w/wed_1/guests/rsvps",
};

describe("rsvp-change-digest", () => {
  it("names the wedding in the subject and counts each kind of change in both bodies", () => {
    const out = renderTemplate("rsvp-change-digest", base);
    expect(out.subject).toBe("RSVP changes for Ama & Jonah");
    expect(out.text).toContain("3 households replied");
    expect(out.text).toContain("1 household changed their reply");
    expect(out.html).toContain("3 households replied");
    expect(out.html).toContain("1 household changed their reply");
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("leaves out a kind nobody made", () => {
    const out = renderTemplate("rsvp-change-digest", base);
    expect(out.text).not.toContain("plus-one");
  });

  it("words the plus-one kinds", () => {
    const out = renderTemplate("rsvp-change-digest", {
      ...base,
      counts: { plus_one_added: 2, plus_one_renamed: 1, plus_one_removed: 1 },
    });
    expect(out.text).toContain("2 households added a plus-one");
    expect(out.text).toContain("1 household changed their plus-one's name");
    expect(out.text).toContain("1 household removed their plus-one");
  });

  it("links to the RSVP page and says how to stop the email", () => {
    const out = renderTemplate("rsvp-change-digest", base);
    expect(out.text).toContain(`See who: ${base.rsvpUrl}`);
    expect(out.html).toContain(`href="${base.rsvpUrl}"`);
    expect(out.text).toContain("turn off");
    expect(out.text).toContain("Email me a daily summary");
  });

  it("escapes the wedding name and the link in the HTML body", () => {
    const out = renderTemplate("rsvp-change-digest", {
      ...base,
      weddingName: `<b>Ama</b> & "Jo"`,
      rsvpUrl: `https://host.example.test/"><script>`,
    });
    expect(out.html).not.toContain("<b>Ama</b>");
    expect(out.html).toContain("&lt;b&gt;Ama&lt;/b&gt; &amp; &quot;Jo&quot;");
    expect(out.html).not.toContain(`"><script>`);
  });

  it("keeps the subject on one line whatever the wedding is called", () => {
    const out = renderTemplate("rsvp-change-digest", {
      ...base,
      weddingName: "Ama\r\nBcc: someone@example.test",
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
  });
});
