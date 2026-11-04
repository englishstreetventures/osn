/**
 * The guest footer's words, held to 4.5:1 on every palette a couple can give
 * their invitation.
 *
 * The footer paints nothing of its own: its words sit on the page, in the
 * palette's secondary ink and its readable gold, which the invitation's
 * documents derive from the couple's colours (`paletteRootVars`). So it is
 * measured where a guest sees it — the footer as the site serves it (rendered
 * by Astro in the node process, `renderGuestFooter`), in the site's own
 * stylesheet — under every preset, and under the seeds off a live wedding,
 * a palette an organiser built by hand whose gilt the palette had to darken
 * to read.
 *
 * Every word is measured: the couple's names, the tagline, each legal link,
 * the "Privacy choices" control and the version; and each action again in the
 * readable gold it turns under the pointer.
 */

import { PALETTE_PRESET_KEYS, WCAG_TEXT_MIN } from "@cire/theme";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { applyPaletteToRoot, type InviteTheme } from "../../src/components/invite-theme";
import { wordsRatio } from "../test-support/paint";

type Render = (options: { closing: string | null }) => Promise<{ html: string; css: string }>;
const renderGuestFooter = (commands as unknown as { renderGuestFooter: Render }).renderGuestFooter;

const PALETTES: { name: string; theme: InviteTheme }[] = [
  ...PALETTE_PRESET_KEYS.map((palettePreset) => ({
    name: `the ${palettePreset} preset`,
    theme: { palettePreset, headingFont: null, bodyFont: null },
  })),
  {
    name: "a live wedding's seeds, its gilt darkened by the palette",
    theme: {
      headingFont: null,
      bodyFont: null,
      palette: {
        ground: "#CEC6B6",
        card: "#D6CFC2",
        ink: "#242218",
        gilt: "#938976",
        bloom: "#C7D1D5",
      },
    },
  },
];

let footer: { html: string; css: string };
const sheet = document.createElement("style");
const host = document.createElement("div");

beforeAll(async () => {
  footer = await renderGuestFooter({ closing: "Ana & Jyoti" });
  sheet.textContent = footer.css;
  document.head.append(sheet);
  host.innerHTML = footer.html;
  document.body.append(host);
}, 30_000);

afterEach(() => {
  applyPaletteToRoot(null);
});

/**
 * Apply `theme`, then wait out the colour transitions it starts: the links
 * move their colour on `--dur-fast`, so a reading taken at once would measure
 * a colour between two palettes.
 */
async function paint(theme: InviteTheme) {
  applyPaletteToRoot(theme);
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
}

afterAll(() => {
  sheet.remove();
  host.remove();
});

/** Each word the footer draws, by what a guest reads it as. */
function words(): [string, Element][] {
  const one = (selector: string) => {
    const found = host.querySelector(selector);
    if (!found) throw new Error(`the footer draws no ${selector}`);
    return found;
  };
  return [
    ["the couple's names", one(".signoff")],
    ["the tagline", one(".tagline")],
    ...[...host.querySelectorAll(".legal-row a")].map((link): [string, Element] => [
      `"${link.textContent}"`,
      link,
    ]),
    ['"Privacy choices"', one(".consent-link")],
    ["the version", one(".version")],
  ];
}

describe("the guest footer as served", () => {
  it("draws every word it is given", () => {
    expect(words().map(([name]) => name)).toEqual([
      "the couple's names",
      "the tagline",
      '"Privacy notice"',
      '"Terms"',
      '"Privacy choices"',
      "the version",
    ]);
    expect(host.querySelector(".signoff")?.textContent).toBe("Ana & Jyoti");
    expect(host.querySelector(".tagline")?.textContent).toBe("Wedding stamped with Cire");
  });
});

describe.each(PALETTES)("the guest footer on $name", ({ theme }) => {
  it("holds every word at 4.5:1 on the page", async () => {
    await paint(theme);
    const ratios = words().map(([name, el]) => [name, wordsRatio(el)] as const);
    expect(ratios.filter(([, ratio]) => ratio < WCAG_TEXT_MIN)).toEqual([]);
  });

  it("holds each action at 4.5:1 in the gold it turns under the pointer", async () => {
    await paint(theme);
    const actions = [...host.querySelectorAll(".legal-row a, .consent-link")];
    const ratios: (readonly [string, number])[] = [];
    // The names are drawn in the readable gold; an action has turned once its
    // colour, which moves on `--dur-fast`, is that gold.
    const gold = getComputedStyle(host.querySelector(".signoff")!).color;
    for (const action of actions) {
      await userEvent.hover(action);
      await vi.waitFor(() => expect(getComputedStyle(action).color).toBe(gold));
      ratios.push([action.textContent ?? "", wordsRatio(action)]);
    }
    await userEvent.unhover(actions.at(-1)!);
    expect(ratios.filter(([, ratio]) => ratio < WCAG_TEXT_MIN)).toEqual([]);
  });
});
