/**
 * The legal pages' draft line is `@shared/ui`'s warn `Notice` at `sm`: warn
 * ink and its mark on the warn wash, the one place Musubi paints warn as ink
 * (DESIGN.md §Status colours).
 *
 * No E2E flow opens Musubi's legal pages, so the look is held here, in a real
 * engine: the line's computed paint against a reference `Notice` rendered
 * beside it, in both themes. A line drawn by hand in look-alike classes still
 * fails on the mark and the word read in its place.
 */

import { Notice } from "@shared/ui/ui/notice";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import "../../src/App.css";
import { LegalDocument } from "../../src/components/LegalDocument";

const PAINT = [
  "color",
  "backgroundColor",
  "borderTopColor",
  "borderTopWidth",
  "borderTopLeftRadius",
  "paddingTop",
  "paddingLeft",
  "fontSize",
  "lineHeight",
] as const;

function paint(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  return Object.fromEntries(PAINT.map((prop) => [prop, style[prop]]));
}

beforeAll(() => {
  // A theme flip starts every colour transition, and a read on the next line
  // returns the old colour. The measurement wants the settled paint.
  const stop = document.createElement("style");
  stop.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(stop);
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the legal pages' draft line", () => {
  it.each(["light", "dark"])("is a warn Notice at sm, in %s", (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const { container, getByTestId, getByText } = render(() => (
      <>
        <LegalDocument title="Privacy Notice" updated="2026-10-30" draft>
          <p>Body.</p>
        </LegalDocument>
        <Notice tone="warn" size="sm" data-testid="reference">
          Reference
        </Notice>
      </>
    ));
    // The line opens the article, above its title.
    const line = container.querySelector("article")?.firstElementChild;
    if (!line) throw new Error("the article has no draft line");

    expect(paint(line)).toEqual(paint(getByTestId("reference")));
    expect(line.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(line.textContent).toMatch(/^Warning: Draft — this notice is not final\./);
    expect(getComputedStyle(getByText("Draft")).fontWeight).toBe("500");
  });
});
