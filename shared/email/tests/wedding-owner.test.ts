import { describe, it, expect } from "vitest";

import { renderTemplate } from "../src/templates";
import type { WeddingOwnerChangeData } from "../src/templates";

/**
 * The owner notices must name who acted in every copy, and the delete notice
 * must say how long the wedding can be restored — the two facts each email
 * exists to carry.
 */

const change: WeddingOwnerChangeData = {
  weddingName: "Ama & Jonah",
  actorName: "Ama Mensah (@ama)",
  subjectName: "@jonah",
  change: "removed",
  audience: "owner",
  self: false,
  portalUrl: "https://host.example.test",
};

describe("wedding-owner-change", () => {
  it("names the actor and the subject to the other owners", () => {
    const out = renderTemplate("wedding-owner-change", change);
    expect(out.text).toContain("Ama Mensah (@ama) removed @jonah as an owner of Ama & Jonah.");
    expect(out.html).toContain("Ama Mensah (@ama) removed @jonah as an owner of Ama &amp; Jonah.");
    expect(out.text).toContain("https://host.example.test");
  });

  it("tells the subject who removed or demoted them", () => {
    const removed = renderTemplate("wedding-owner-change", { ...change, audience: "subject" });
    expect(removed.text).toContain("Ama Mensah (@ama) removed you as an owner of Ama & Jonah.");

    const demoted = renderTemplate("wedding-owner-change", {
      ...change,
      audience: "subject",
      change: "demoted",
      newRole: "viewer",
    });
    expect(demoted.text).toContain(
      "Ama Mensah (@ama) changed your role on Ama & Jonah from owner to viewer.",
    );
  });

  it("speaks to the actor in the second person", () => {
    const out = renderTemplate("wedding-owner-change", { ...change, audience: "actor" });
    expect(out.text).toContain("You removed @jonah as an owner of Ama & Jonah.");
  });

  it("reads as a step-down when the subject acted on their own seat", () => {
    const own = renderTemplate("wedding-owner-change", {
      ...change,
      audience: "subject",
      self: true,
      change: "demoted",
      newRole: "editor",
    });
    expect(own.text).toContain(
      "You stepped down as an owner of Ama & Jonah. You are now an editor.",
    );

    const others = renderTemplate("wedding-owner-change", {
      ...change,
      actorName: "@jonah",
      self: true,
    });
    expect(others.text).toContain("@jonah left Ama & Jonah.");
  });

  it("falls back to generic wording when OSN could not say who was involved", () => {
    const out = renderTemplate("wedding-owner-change", { ...change, actorName: null });
    expect(out.text).toContain("Another owner removed @jonah");

    const unnamed = renderTemplate("wedding-owner-change", {
      ...change,
      actorName: null,
      subjectName: null,
    });
    expect(unnamed.text).toContain("Another owner removed one of the owners of Ama & Jonah.");
  });

  it("escapes the names in the HTML body and keeps the subject on one line", () => {
    const out = renderTemplate("wedding-owner-change", {
      ...change,
      weddingName: "A\r\nB <x>",
      actorName: '<script>"',
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;&quot;");
  });
});

describe("wedding-owner-change — the other wordings", () => {
  it("words a demotion for the actor and the other owners, named or not", () => {
    const demoted = { ...change, change: "demoted" as const, newRole: "viewer" as const };
    expect(
      renderTemplate("wedding-owner-change", { ...demoted, audience: "actor" }).text,
    ).toContain("You changed @jonah's role on Ama & Jonah from owner to viewer.");
    expect(
      renderTemplate("wedding-owner-change", { ...demoted, subjectName: null }).text,
    ).toContain("Ama Mensah (@ama) changed one owner's role on Ama & Jonah to viewer.");
  });

  it("defaults a demotion without a role to editor, and picks the article", () => {
    const own = { ...change, change: "demoted" as const, audience: "subject" as const, self: true };
    expect(renderTemplate("wedding-owner-change", own).text).toContain("You are now an editor.");
    expect(renderTemplate("wedding-owner-change", { ...own, newRole: "viewer" }).text).toContain(
      "You are now a viewer.",
    );
  });

  it("speaks of an unnamed owner who left", () => {
    const out = renderTemplate("wedding-owner-change", {
      ...change,
      self: true,
      subjectName: null,
    });
    expect(out.text).toContain("One of the owners left Ama & Jonah.");
  });

  it("tells the owners who made someone an owner, and what that grants", () => {
    const added = renderTemplate("wedding-owner-change", { ...change, change: "added" });
    expect(added.text).toContain("Ama Mensah (@ama) added @jonah to Ama & Jonah as an owner.");
    expect(added.text).toContain("deleting the wedding");
    const promoted = renderTemplate("wedding-owner-change", {
      ...change,
      change: "promoted",
      audience: "actor",
    });
    expect(promoted.text).toContain("You made @jonah an owner of Ama & Jonah.");
    expect(promoted.text).toContain("If this was not you");
  });
});

describe("wedding-delete-started", () => {
  const base = {
    weddingName: "Ama & Jonah",
    actorName: "Ama Mensah (@ama)",
    audience: "owner" as const,
    restoreUntil: "9 October 2026 at 14:05 UTC",
    restoreDays: 7,
    portalUrl: "https://host.example.test",
  };

  it("tells the deleter it was them, and what to do if it was not", () => {
    const out = renderTemplate("wedding-delete-started", { ...base, audience: "actor" });
    expect(out.text).toContain("You deleted Ama & Jonah.");
    expect(out.text).toContain("If this was not you");
  });

  it("falls back to a generic name, says 1 day, and escapes the name", () => {
    const out = renderTemplate("wedding-delete-started", {
      ...base,
      actorName: null,
      restoreDays: 1,
      weddingName: "<b>Ama</b>",
    });
    expect(out.text).toContain("Another owner deleted");
    expect(out.text).toContain("for 1 day:");
    expect(out.html).not.toContain("<b>Ama</b>");
    expect(out.html).toContain("&lt;b&gt;Ama&lt;/b&gt;");
  });

  it("names the deleter and the restore window", () => {
    const out = renderTemplate("wedding-delete-started", {
      weddingName: "Ama & Jonah",
      actorName: "Ama Mensah (@ama)",
      audience: "owner",
      restoreUntil: "9 October 2026, 14:05 UTC",
      restoreDays: 7,
      portalUrl: "https://host.example.test",
    });
    expect(out.subject).toBe("Ama & Jonah has been deleted");
    for (const body of [out.text, out.html]) {
      expect(body).toContain("Ama Mensah (@ama) deleted Ama");
      expect(body).toContain("for 7 days: until 9 October 2026, 14:05 UTC");
      expect(body).toContain("cannot get it back");
    }
  });
});
