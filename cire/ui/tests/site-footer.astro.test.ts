import { readFileSync } from "node:fs";
import { join } from "node:path";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { Window } from "happy-dom";
import { beforeAll, describe, expect, it } from "vitest";

import SiteFooter from "../src/site-footer.astro";

/**
 * The footer as both guest-facing sites will serve it, rendered by Astro's
 * container API: every link it is given, in order; the sign-off only when
 * there is one, in its own face; the standing privacy-choices control inside
 * the legal row; the version as a bug report quotes it. Then what only the
 * source shows: no text in the metal gold, a focus ring that never animates,
 * and the 44px touch floor.
 */

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const LEGAL = [
  { href: "/privacy", label: "Privacy notice" },
  { href: "/terms", label: "Terms" },
  { href: "/refunds", label: "Refunds" },
];
const SECTIONS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#faq", label: "Questions" },
];

async function footer(props: Record<string, unknown>, slots: Record<string, string> = {}) {
  const html = await container.renderToString(SiteFooter, { props, slots });
  // Parsed in a window of its own: Astro renders under Node, not in a DOM.
  const doc = new new Window().DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("footer")! as unknown as Element;
}

const anchors = (el: Element | null) =>
  [...(el?.querySelectorAll("a") ?? [])].map((a) => [
    a.getAttribute("href"),
    a.textContent?.trim(),
  ]);

describe("SiteFooter", () => {
  it("renders every legal link it is given, in order, in a navigation named Legal", async () => {
    const el = await footer({ links: LEGAL });
    expect(anchors(el.querySelector('nav[aria-label="Legal"]'))).toEqual(
      LEGAL.map((l) => [l.href, l.label]),
    );
  });

  it("renders every section link it is given, and no section row when given none", async () => {
    const withSections = await footer({ links: LEGAL, sections: SECTIONS });
    expect(anchors(withSections.querySelector('nav[aria-label="Sections"]'))).toEqual(
      SECTIONS.map((l) => [l.href, l.label]),
    );
    const without = await footer({ links: LEGAL });
    expect(without.querySelector('nav[aria-label="Sections"]')).toBeNull();
  });

  it("keeps each dot with the link after it, and leads with none", async () => {
    const el = await footer({ links: LEGAL });
    const items = [...el.querySelectorAll('nav[aria-label="Legal"] > .item')];
    expect(items).toHaveLength(LEGAL.length);
    expect(items[0]!.textContent?.trim()).toBe("Privacy notice");
    for (const item of items.slice(1)) {
      expect(item.querySelector('[aria-hidden="true"]')?.textContent).toBe("·");
    }
  });

  it("uses no class of the legal pages' own, whose rules are global on the pages it ends", async () => {
    const el = await footer({ links: LEGAL, sections: SECTIONS, version: "45a21eb" });
    expect(el.querySelector(".legal")).toBeNull();
    expect(el.classList.contains("legal")).toBe(false);
  });

  it("starts at the legal row when there is no sign-off", async () => {
    const el = await footer({ links: LEGAL });
    expect(el.querySelector(".signoff")).toBeNull();
    expect(el.querySelector(".tagline")).toBeNull();
    expect(el.querySelector("hr")).toBeNull();
  });

  it("signs off in the face it is given, with its tagline and the rule", async () => {
    const names = await footer({
      links: LEGAL,
      signoff: { title: "Ana & Jyoti", tagline: "Wedding stamped with Cire", face: "names" },
    });
    expect(names.querySelector(".signoff")?.textContent).toBe("Ana & Jyoti");
    expect(names.querySelector(".signoff")?.getAttribute("data-face")).toBe("names");
    expect(names.querySelector(".tagline")?.textContent).toBe("Wedding stamped with Cire");
    expect(names.querySelector("hr")).not.toBeNull();
    const mark = await footer({
      links: LEGAL,
      signoff: { title: "Cire", tagline: "Invitations worthy of the moment.", face: "wordmark" },
    });
    expect(mark.querySelector(".signoff")?.getAttribute("data-face")).toBe("wordmark");
  });

  it("prints the version untranslated, the small print, and neither when not given", async () => {
    const el = await footer({ links: LEGAL, version: "45a21eb", smallPrint: "© 2026 Cire." });
    const version = el.querySelector(".version");
    expect(version?.textContent?.replace(/\s+/g, " ").trim()).toBe("Version 45a21eb");
    expect(version?.getAttribute("translate")).toBe("no");
    expect(el.querySelector(".small-print")?.textContent).toBe("© 2026 Cire.");
    const bare = await footer({ links: LEGAL });
    expect(bare.querySelector(".version")).toBeNull();
    expect(bare.querySelector(".small-print")).toBeNull();
  });

  it("puts the privacy-choices control inside the legal row, after a dot", async () => {
    const el = await footer(
      { links: LEGAL.slice(0, 2) },
      { consent: '<button type="button" class="consent-link">Privacy choices</button>' },
    );
    const legal = el.querySelector('nav[aria-label="Legal"]');
    const control = legal?.querySelector("button.consent-link");
    expect(control?.textContent).toBe("Privacy choices");
    expect(control?.closest(".item")?.querySelector('[aria-hidden="true"]')?.textContent).toBe("·");
  });
});

describe("SiteFooter's styles", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/site-footer.astro"), "utf8");
  const style = source.slice(source.indexOf("<style>"));

  it("colours no text in the metal gold", () => {
    expect(style).not.toMatch(/(^|[^-])color:\s*var\(--ui-accent(-soft)?[,)]/m);
  });

  it("names what it transitions, so a focus ring never animates", () => {
    const transitions = style.match(/transition:[^;]*;/g) ?? [];
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) expect(t).not.toMatch(/\ball\b|outline/);
  });

  it("gives every footer action a 44px hit area laid over its word", () => {
    expect(style).toMatch(
      /\.site-footer a::after,\s*\.site-footer :global\(\.consent-link\)::after \{[^}]*position: absolute;[^}]*min-height: 2\.75rem;/,
    );
  });
});
