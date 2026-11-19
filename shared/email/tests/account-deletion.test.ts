import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";
import type {
  AccountDeletedData,
  AccountDeletionScheduledData,
  OrganisationOwnershipReceivedData,
} from "../src/templates";

// The account-deletion emails each exist to carry a few facts — a date, what
// stays and where, how to change one's mind — and every one of them carries
// text another party wrote: an app's label, a wedding or organisation name, a
// kept item. Each test below checks a fact the email must state, or that text
// from elsewhere is escaped and kept out of the subject.

/** 2026-11-23 14:05:00 UTC. */
const DELETES_AT = Date.UTC(2026, 10, 23, 14, 5) / 1_000;

const scheduled: AccountDeletionScheduledData = {
  instanceName: "Acme",
  deletesAt: DELETES_AT,
  appUrl: "https://app.example.test",
  deleteEverything: false,
  plan: [
    {
      label: 'You are the only owner of "Ama <script>alert(1)</script> & Jonah".',
      outcome: "Deleted with its guests, replies and invite when your account is deleted.",
      keptUntil: null,
    },
    {
      label: "You host 1 upcoming event.",
      outcome: "Cancelled and kept for its guests.",
      keptUntil: Date.UTC(2026, 11, 7) / 1_000,
    },
  ],
};

describe("account-deletion-scheduled", () => {
  // The account is erased at or after `deletesAt`, often hours after, and can
  // be kept only before it. So the email names the day, never a clock time,
  // and nothing in it promises a moment past `deletesAt`. The reader's zone is
  // unknown, so the day is UTC's and says so.
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env.TZ;
    // Far from UTC, so a date read in the host's zone shows.
    process.env.TZ = "Pacific/Kiritimati";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("says the account is deleted on or shortly after a day in UTC, with no clock time", () => {
    const out = renderTemplate("account-deletion-scheduled", scheduled);
    expect(out.text).toContain("It will be deleted on or shortly after 23 November 2026 (UTC).");
    expect(out.html).toContain("It will be deleted on or shortly after 23 November 2026 (UTC).");
    expect(out.text).not.toMatch(/\d:\d\d/);
    expect(out.html).not.toMatch(/\d:\d\d/);
  });

  it("names the UTC day either side of midnight UTC", () => {
    const late = renderTemplate("account-deletion-scheduled", {
      ...scheduled,
      deletesAt: Date.UTC(2026, 10, 23, 23, 30) / 1_000,
    });
    expect(late.text).toContain("on or shortly after 23 November 2026 (UTC)");
    const early = renderTemplate("account-deletion-scheduled", {
      ...scheduled,
      deletesAt: Date.UTC(2026, 10, 24, 0, 30) / 1_000,
    });
    expect(early.text).toContain("on or shortly after 24 November 2026 (UTC)");
  });

  it("offers the keep and the download only before the day, never up to it", () => {
    const out = renderTemplate("account-deletion-scheduled", scheduled);
    expect(out.text).toContain("sign in to Acme before that day");
    expect(out.text).toContain("Once it is deleted, there is nothing left to download.");
    expect(out.text).not.toMatch(/until (then|that day|23 November)/i);
  });

  it("says how to keep the account and how to download the data, with the app's address", () => {
    const out = renderTemplate("account-deletion-scheduled", scheduled);
    expect(out.text).toContain("Keep my account");
    expect(out.text).toContain("Download my data");
    expect(out.text).toContain("https://app.example.test");
  });

  it("lists each line of the plan with what happens, and the date anything kept is erased", () => {
    const out = renderTemplate("account-deletion-scheduled", scheduled);
    expect(out.text).toContain("You host 1 upcoming event.");
    expect(out.text).toContain("Cancelled and kept for its guests.");
    expect(out.text).toContain("Kept until 7 December 2026 (UTC).");
  });

  it("escapes a name another person wrote and keeps it out of the subject", () => {
    const out = renderTemplate("account-deletion-scheduled", scheduled);
    expect(out.html).toContain("Ama &lt;script&gt;alert(1)&lt;/script&gt; &amp; Jonah");
    expect(out.html).not.toContain("<script>");
    expect(out.subject).not.toContain("Ama");
  });

  it("says so when the person chose to delete everything", () => {
    const out = renderTemplate("account-deletion-scheduled", {
      ...scheduled,
      deleteEverything: true,
    });
    expect(out.text).toContain("You chose to delete everything");
  });

  it("says when there is nothing anywhere else to settle", () => {
    const out = renderTemplate("account-deletion-scheduled", { ...scheduled, plan: [] });
    expect(out.text).toContain("Nothing else needed an answer");
  });
});

describe("account-deletion-cancelled", () => {
  it("says the account will not be deleted, with the app's address", () => {
    const out = renderTemplate("account-deletion-cancelled", {
      instanceName: "Acme",
      appUrl: "https://app.example.test",
    });
    expect(out.subject).toBe("Your Acme account will not be deleted");
    expect(out.text).toContain("https://app.example.test");
  });
});

const deleted: AccountDeletedData = {
  instanceName: "Acme",
  handles: ["ada", "ada_work"],
  handlesHeldUntil: Date.UTC(2026, 11, 23, 14, 5) / 1_000,
  kept: [
    {
      app: "Pulse",
      what: "Your event <b>Launch</b>, for its guests.",
      erasedOn: Date.UTC(2026, 11, 7) / 1_000,
      requestUrl: "https://pulse.example.test/request",
    },
  ],
  organisations: [
    { handle: "adaco", newOwnerHandle: "bea" },
    { handle: "side", newOwnerHandle: null },
  ],
};

describe("account-deleted", () => {
  it("says the account is gone and cannot be brought back", () => {
    const out = renderTemplate("account-deleted", deleted);
    expect(out.subject).toBe("Your Acme account has been deleted");
    expect(out.text).toContain("cannot be brought back");
  });

  it("names each handle held and the date it is released", () => {
    const out = renderTemplate("account-deleted", deleted);
    expect(out.text).toContain("@ada");
    expect(out.text).toContain("@ada_work");
    // The hold ends at an instant: "before then" holds only if the zone is named.
    expect(out.text).toContain(
      "held until 23 December 2026 (UTC). Nobody can take them before then",
    );
  });

  it("lists each kept item with its app, its erase date and where to ask about it", () => {
    const out = renderTemplate("account-deleted", deleted);
    expect(out.text).toContain("Pulse");
    expect(out.text).toContain("Kept until 7 December 2026 (UTC).");
    expect(out.text).toContain("https://pulse.example.test/request");
    expect(out.html).toContain("&lt;b&gt;Launch&lt;/b&gt;");
    expect(out.html).not.toContain("<b>Launch</b>");
  });

  it("says where each organisation went, by handle", () => {
    const out = renderTemplate("account-deleted", deleted);
    expect(out.text).toContain("@adaco now belongs to @bea.");
    expect(out.text).toContain("@side was deleted.");
    expect(out.html).toContain("@adaco now belongs to @bea.");
  });

  it("says nothing is kept when no app kept anything", () => {
    const out = renderTemplate("account-deleted", { ...deleted, kept: [], organisations: [] });
    expect(out.text).toContain("No app kept anything");
  });
});

const received: OrganisationOwnershipReceivedData = {
  instanceName: "Acme",
  organisationHandle: "adaco",
  declineUrl: "https://app.example.test/organisations/adaco?decline=1",
  declineUntil: Date.UTC(2026, 11, 23, 14, 5) / 1_000,
  cause: "owner_deleted",
};

describe("organisation-ownership-received", () => {
  it("names the organisation by its handle, the reason, and how and until when to decline", () => {
    const out = renderTemplate("organisation-ownership-received", received);
    expect(out.text).toContain("@adaco");
    expect(out.text).toContain("deleted their account");
    expect(out.text).toContain("https://app.example.test/organisations/adaco?decline=1");
    expect(out.text).toContain("23 December 2026");
  });

  it("says why when the one before declined it", () => {
    const out = renderTemplate("organisation-ownership-received", {
      ...received,
      cause: "owner_declined",
    });
    expect(out.text).toContain("declined it");
  });

  it("carries no text the organisation's members wrote: the subject is fixed", () => {
    const out = renderTemplate("organisation-ownership-received", received);
    expect(out.subject).toBe("You now own an organisation on Acme");
  });
});

describe("account-data-link", () => {
  it("carries the page's address and says the email holds no data", () => {
    const out = renderTemplate("account-data-link", {
      instanceName: "Acme",
      url: "https://app.example.test/settings#account",
    });
    expect(out.text).toContain("https://app.example.test/settings#account");
    expect(out.text).toContain("holds none of your data");
  });
});
