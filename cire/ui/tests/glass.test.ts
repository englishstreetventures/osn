import { describe, expect, it } from "vitest";

import { buttonClass } from "../src/button";
import { GLASS_CHOICE, GLASS_FILL } from "../src/lib/glass";
import tabsSource from "../src/segmented-tabs.tsx?raw";

/*
 * `Button`'s `glass` is the strip's glass on a pill of its own (the
 * 2026-11-04 consistency audit, item 4). Tailwind reads source as text, so its
 * chosen look cannot be `GLASS_FILL` with a state put in front at run time: it
 * is written out again behind the chosen state. These hold the two copies to
 * one look, so the glass on a preset never drifts from the glass in a strip.
 */

/** The chosen state's variant, as `GLASS_CHOICE` writes it. */
const CHOSEN = "base:[&:is([aria-pressed=true],[aria-checked=true])]:";

/** The strip's halfway hover colour and ink, as `segmented-tabs.tsx` writes them. */
function stripHover(): string[] {
  return [...tabsSource.matchAll(/base:not-data-\[chosen\]:hover:(\[[^\]"]+\])/g)].map(
    (m) => m[1]!,
  );
}

describe("GLASS_CHOICE", () => {
  const classes = GLASS_CHOICE.split(/\s+/);

  it("wears the strip's glass, declaration for declaration, when chosen", () => {
    const chosen = classes.filter((c) => c.startsWith(CHOSEN));
    for (const fill of GLASS_FILL.split(/\s+/)) {
      expect(chosen).toContain(fill.replace("base:", CHOSEN));
    }
  });

  it("marks the chosen word in readable gold and drops the hairline for the glass's own edge", () => {
    expect(classes).toEqual(
      expect.arrayContaining([`${CHOSEN}text-ui-accent-ink`, `${CHOSEN}border-transparent`]),
    );
  });

  it("rests on the track's look: a hairline, the portals' ground, the secondary ink", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        "base:border-ui-hairline",
        "base:bg-[color:var(--pill-ground,transparent)]",
        "base:text-ui-ink-secondary",
      ]),
    );
  });

  it("goes halfway under the pointer exactly as a strip's choice does", () => {
    const hover = stripHover();
    expect(hover).toHaveLength(2);
    const gate = "not-aria-pressed:not-aria-checked:not-aria-disabled:hover:base:";
    for (const declaration of hover) {
      expect(classes).toContain(`${gate}${declaration}`);
    }
  });

  it("keeps an outline on the chosen pill in a contrast theme", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        `base:forced-colors:${CHOSEN.slice("base:".length)}outline-1`,
        `base:forced-colors:${CHOSEN.slice("base:".length)}outline-solid`,
      ]),
    );
  });

  it("is what `Button` draws for `glass`", () => {
    const button = buttonClass({ variant: "glass" }).split(/\s+/);
    for (const c of classes) expect(button).toContain(c);
  });
});
