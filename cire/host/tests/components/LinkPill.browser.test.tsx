/**
 * A link that stands alone, drawn as a pill, measured with the portal's own
 * stylesheet in Chromium.
 *
 * Each case is one way the pill can fail someone: it is not the portal's 28px
 * pill height; a marked pill keeps its word in a row too narrow for it, or
 * loses its name when it drops the word; a pill with no mark turns into an
 * empty circle; or its gold word under the pointer falls under 4.5:1 on the
 * page or a card in either theme.
 */

import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cardClass } from "@cire/ui/card";
import { cleanup, render, screen } from "@solidjs/testing-library";
import Globe from "lucide-solid/icons/globe";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { InstagramMark, LINK_PILL_ROW, LinkPill } from "../../src/components/LinkPill";

import "../../src/styles/global.css";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

function Row(props: { width: string; children: JSX.Element }) {
  return (
    <div style={{ width: props.width }} class={LINK_PILL_ROW}>
      {props.children}
    </div>
  );
}

function pills() {
  return (
    <>
      <LinkPill href="https://bloom.example" mark={Globe} label="Website" />
      <LinkPill href="https://instagram.com/bloom" mark={InstagramMark} label="Instagram" />
      <LinkPill
        href="https://shop.example/napkins"
        hint="to the shop page for Napkins"
        label="Link"
      />
    </>
  );
}

const box = (el: Element) => el.getBoundingClientRect();
/** The word's own box: zero-sized once it is visually hidden. */
const word = (link: HTMLElement) => box(link.querySelector("span")!);

describe("LinkPill", () => {
  it("is the portal's 28px pill, word and mark side by side, in a row with room", () => {
    render(() => <Row width="40rem">{pills()}</Row>);
    for (const name of [/^Website/, /^Instagram/, /^Link/]) {
      const link = screen.getByRole("link", { name });
      expect(box(link).height).toBe(28);
      expect(box(link).width).toBeGreaterThan(40);
      expect(word(link).width).toBeGreaterThan(10);
      const radius = Number.parseFloat(getComputedStyle(link).borderTopLeftRadius);
      expect(radius).toBeGreaterThanOrEqual(14);
    }
  });

  it("drops a marked pill's word to a 28px circle in a narrow row, keeping its name", () => {
    render(() => <Row width="12rem">{pills()}</Row>);
    for (const name of ["Website (opens in a new tab)", "Instagram (opens in a new tab)"]) {
      const link = screen.getByRole("link", { name });
      expect(box(link).width).toBe(28);
      expect(box(link).height).toBe(28);
      expect(word(link).width).toBeLessThanOrEqual(1);
    }
    // A pill with no mark has nothing to show as a circle: it keeps its word.
    const plain = screen.getByRole("link", {
      name: "Link to the shop page for Napkins (opens in a new tab)",
    });
    expect(word(plain).width).toBeGreaterThan(10);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const [ground, wrap] of [
      ["page", (pill: JSX.Element) => <div>{pill}</div>],
      ["card", (pill: JSX.Element) => <div class={cardClass()}>{pill}</div>],
    ] as const) {
      it(`holds its word at ${WCAG_TEXT_MIN}:1 under the pointer on the ${ground}, ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        render(() => wrap(<LinkPill href="https://bloom.example" mark={Globe} label="Website" />));
        const link = screen.getByRole("link");
        await userEvent.hover(link);
        await Promise.all(link.getAnimations().map((a) => a.finished));
        const under = backdropOf(link);
        const ink = composite([under, getComputedStyle(link).color]);
        expect(contrastRatio(ink, under)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
      });
    }
  }
});

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** What `element` paints its word over: the page's ground, then every
 *  background from the outermost ancestor in, its own last. */
function backdropOf(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers]);
}
