import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderTemplate, type ChangeNoticeData } from "../src/templates";

// The change notice tells every account holder that a page they agreed to is
// changing: which page, what changes, the day it takes effect, and where to
// read it. It is a legal notice, not marketing, so it carries no unsubscribe
// link or header. Each test checks a fact the email must state, or that the
// notice's own text is escaped and kept off the subject's line.

/** 1 January 2027, 00:00 UTC. */
const TAKES_EFFECT = Date.UTC(2027, 0, 1) / 1_000;

const notice: ChangeNoticeData = {
  instanceName: "Acme",
  document: "privacy notice",
  changes: [
    "We now keep sign-in records for 12 months, not 6.",
    "Our email provider is named in the list of who we share data with.",
  ],
  takesEffect: TAKES_EFFECT,
  url: "https://app.example.test/privacy",
};

describe("change-notice", () => {
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env.TZ;
    // Behind UTC, so a UTC midnight is the day before in the host's zone, and
    // a date read in the host's zone shows.
    process.env.TZ = "Pacific/Pago_Pago";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("names the page, the instance, each change, the day it takes effect and the link", () => {
    const out = renderTemplate("change-notice", notice);
    expect(out.subject).toBe("Changes to the Acme privacy notice");
    for (const part of [out.text, out.html]) {
      expect(part).toContain("Acme privacy notice");
      expect(part).toContain("1 January 2027");
      for (const line of notice.changes) expect(part).toContain(line);
      expect(part).toContain(notice.url);
    }
    expect(out.html).toContain(`href="${notice.url}"`);
  });

  it("shows the UTC day, not the day in the zone the sender runs in", () => {
    // In Pago Pago (UTC-11) the UTC midnight that starts 1 January 2027 is
    // still 31 December 2026, at 13:00.
    const out = renderTemplate("change-notice", notice);
    expect(out.text).toContain("The changes take effect on 1 January 2027.");
    expect(out.html).toContain("The changes take effect on 1 January 2027.");
  });

  it("escapes the notice's own text in the HTML", () => {
    const out = renderTemplate("change-notice", {
      ...notice,
      document: "terms <b>& conditions</b>",
      changes: ['A "quoted" change & <script>alert(1)</script>'],
      url: 'https://app.example.test/terms?a=1&b="2"><script>',
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<b>");
    expect(out.html).toContain("terms &lt;b&gt;&amp; conditions&lt;/b&gt;");
    expect(out.html).toContain("A &quot;quoted&quot; change &amp; &lt;script&gt;");
    expect(out.html).toContain('href="https://app.example.test/terms?a=1&amp;b=&quot;2&quot;&gt;');
  });

  it("keeps the subject on one line", () => {
    const out = renderTemplate("change-notice", {
      ...notice,
      instanceName: "Acme\r\nBcc: someone@example.test",
      document: "privacy\nnotice",
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.subject).toBe("Changes to the Acme Bcc: someone@example.test privacy notice");
  });

  it("carries no unsubscribe header or link: it is a legal notice, not marketing", () => {
    const out = renderTemplate("change-notice", notice);
    expect(out.headers).toBeUndefined();
    expect(out.html).not.toMatch(/<a [^>]*>[^<]*unsubscribe/i);
    expect(`${out.text}\n${out.html}`).toContain("nothing to unsubscribe from");
  });
});
