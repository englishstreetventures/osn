import type { JSX } from "solid-js";

import { createWelcomeBack, HERO_FALLBACK_TITLE, WELCOME_BACK } from "./returning-household";

/**
 * Where the shorter string sits in the cell the longer one sizes. Literal
 * class strings, so Tailwind's scanner emits them.
 *
 * - `center`: in the middle of the cell, for a title block centred in the hero.
 * - `end`: on the cell's bottom edge, against the subtitle, for a title block
 *   anchored to the hero's foot.
 */
const ALIGN = {
  center: "items-center",
  end: "items-end",
} as const;

export type HeroFallbackTitleAlign = keyof typeof ALIGN;

interface HeroFallbackTitleProps {
  /** The pack's title type: font, colour, size, text alignment, wrapping. */
  class: string;
  align: HeroFallbackTitleAlign;
}

/** Both strings share the grid's one cell. */
const SLOT = "col-start-1 row-start-1";

/**
 * The hero's title when the organiser gave none: "You're Invited", or "Welcome
 * back to your invite" for a household that has replied before.
 *
 * Both strings are always in the page, stacked in one grid cell, so the cell
 * is as wide and as tall as the longer of the two from the first paint. When a
 * returning household's session restores and the title changes, the only
 * change is which string is painted; no box in the hero moves. The price is
 * that a first visit's title block holds the room the longer string needs.
 *
 * The string not shown is `invisible` — `visibility: hidden` keeps its box but
 * takes it out of the accessibility tree and out of find-in-page — and
 * `aria-hidden`, which says the same to anything reading the markup without
 * the stylesheet. A screen reader reaches the painted title only.
 *
 * `grid-cols-1` is `minmax(0, 1fr)`, so the cell may be narrower than its
 * longest word and the pack's `break-words` still wraps it under `max-w-full`.
 */
export function HeroFallbackTitle(props: HeroFallbackTitleProps): JSX.Element {
  const welcomeBack = createWelcomeBack();
  return (
    <span class={`grid grid-cols-1 ${ALIGN[props.align]} ${props.class}`}>
      <span
        class={welcomeBack() ? `${SLOT} invisible` : SLOT}
        aria-hidden={welcomeBack() ? "true" : undefined}
      >
        {HERO_FALLBACK_TITLE}
      </span>
      <span
        class={welcomeBack() ? SLOT : `${SLOT} invisible`}
        aria-hidden={welcomeBack() ? undefined : "true"}
      >
        {WELCOME_BACK}
      </span>
    </span>
  );
}
