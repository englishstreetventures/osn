import { describe, expect, it } from "bun:test";

import { DEFAULT_ORGANISER_ORIGIN, organiserOriginFrom } from "../../src/lib/organiser-origin";

// `WEB_ORIGIN` is a comma list — guest invite, organiser portal, vendor portal —
// and every organiser-facing link the cron mails (the RSVP digest's "See who")
// is built on its second entry. A slip to the first would send organisers to
// the guest site with nothing else failing.

describe("organiserOriginFrom", () => {
  it("takes the second entry, trimmed", () => {
    expect(organiserOriginFrom("https://invite.test,https://host.test")).toBe("https://host.test");
    expect(organiserOriginFrom("https://invite.test, https://host.test ,https://vendor.test")).toBe(
      "https://host.test",
    );
  });

  it("falls back to the production portal when the list names no organiser origin", () => {
    expect(organiserOriginFrom("https://invite.test")).toBe(DEFAULT_ORGANISER_ORIGIN);
    expect(organiserOriginFrom("https://invite.test,")).toBe(DEFAULT_ORGANISER_ORIGIN);
    expect(organiserOriginFrom("")).toBe(DEFAULT_ORGANISER_ORIGIN);
    expect(DEFAULT_ORGANISER_ORIGIN).toBe("https://host.cireweddings.com");
  });
});
