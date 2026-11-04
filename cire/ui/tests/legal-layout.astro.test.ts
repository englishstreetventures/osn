import { readFileSync } from "node:fs";
import { join } from "node:path";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import LegalLayout from "../src/legal-layout.astro";
import { unmarkedTypeSizes } from "./test-support/type-literals";

/**
 * The legal pages' document, rendered by Astro's container API: its title in
 * the tab, with the site's name where one is given; the way back only where a
 * site has one; and each of the four slots a site fills, in its place. Then
 * the draft banner's look, which the pages' own legal test relies on being
 * drawn: a page publishing a placeholder must show it.
 */

let container: AstroContainer;
/** One window for every parse: Astro renders under Node, not in a DOM. */
const window = new Window();
beforeAll(async () => {
  container = await AstroContainer.create();
});
afterAll(async () => {
  await window.happyDOM.close();
});

async function page(props: Record<string, unknown>, slots: Record<string, string> = {}) {
  const html = await container.renderToString(LegalLayout, {
    props,
    slots: { default: "<h1>Terms of Service</h1>", ...slots },
  });
  return new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

describe("LegalLayout", () => {
  it("keeps a page's query out of a cross-origin Referer", async () => {
    const doc = await page({ title: "Privacy" });
    expect(doc.head.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("puts its title in the tab, with the site's name after it where given", async () => {
    expect((await page({ title: "Terms of Use" })).title).toBe("Terms of Use");
    expect((await page({ title: "Terms of Service", siteName: "Cire" })).title).toBe(
      "Terms of Service — Cire",
    );
  });

  it("draws the way back above the page where given, and none where not", async () => {
    const withBack = await page({ title: "Refunds", back: { href: "/", label: "← Back to Cire" } });
    const link = withBack.querySelector("main.legal > .legal-back a");
    expect(link?.getAttribute("href")).toBe("/");
    expect(link?.textContent).toBe("← Back to Cire");
    expect(withBack.querySelector("main.legal")?.firstElementChild?.className).toContain(
      "legal-back",
    );
    expect((await page({ title: "Terms" })).querySelector(".legal-back")).toBeNull();
  });

  it("puts each slot in its place: head, the page, the footer, then what follows it", async () => {
    const doc = await page(
      { title: "Privacy" },
      {
        head: '<link rel="preload" href="/font.woff2" as="font">',
        footer: '<footer class="site-footer">Footer</footer>',
        after: '<div id="consent-banner"></div>',
      },
    );
    expect(doc.head.querySelector('link[rel="preload"]')).not.toBeNull();
    expect(doc.querySelector("main.legal h1")?.textContent).toBe("Terms of Service");
    const body = [...doc.body.children].map(
      (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""),
    );
    expect(body.slice(0, 3)).toEqual(["main", "footer", "div#consent-banner"]);
  });
});

describe("LegalLayout's styles", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/legal-layout.astro"), "utf8");
  const style = source.slice(source.indexOf("<style"));

  it("draws the page's rules globally, where the pages' own markup is", () => {
    // The banner, the headings and the placeholders are the page's markup, in
    // the default slot, which a scoped rule would not reach.
    expect(source).toContain("<style is:global>");
  });

  it("draws the draft banner and its readable-gold word", () => {
    expect(style).toMatch(
      /\.legal \.draft-banner \{[^}]*border: 1px solid var\(--ui-accent-soft\);/,
    );
    expect(style).toMatch(/\.legal \.draft-banner strong \{[^}]*color: var\(--ui-accent-ink\);/);
  });

  it("marks a placeholder in readable gold with nothing behind it", () => {
    const rule = style.match(/\.legal \.placeholder \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("color: var(--ui-accent-ink);");
    expect(rule).not.toMatch(/background/);
  });

  it("marks every literal type size as having no token", () => {
    expect(unmarkedTypeSizes(style)).toEqual([]);
  });

  it("colours no text in the metal gold", () => {
    expect(style).not.toMatch(/(^|[^-])color:\s*var\(--ui-accent(-soft)?[,)]/m);
  });

  it("names what it transitions, so a focus ring never animates", () => {
    for (const t of style.match(/transition:[^;]*;/g) ?? [])
      expect(t).not.toMatch(/\ball\b|outline/);
  });
});
