import { createFirstScroll } from "./first-scroll";

/**
 * Where the cue sits along the hero's bottom edge. Literal class strings, so
 * Tailwind's scanner emits them.
 *
 * - `center`: under a centred title.
 * - `end`: in the inline-end corner, on the hero's 1.5rem gutter, opposite a
 *   title anchored bottom-left.
 */
const ALIGN = {
  center: "inset-x-0 justify-center",
  end: "right-6",
} as const;

export type HeroScrollCueAlign = keyof typeof ALIGN;

interface HeroScrollCueProps {
  align?: HeroScrollCueAlign;
}

/**
 * A small gold chevron at the foot of the invite's full-screen hero, telling
 * the guest the page carries on below. Render it as the last child of the
 * hero `<section>`, which must be `relative`.
 *
 * It is a hint, not a control: `aria-hidden`, and `pointer-events-none` so a
 * tap goes to the hero beneath it. It fades in a beat after the title, drifts
 * down and back twice and rests (`animate-scroll-cue`, `styles/global.css`;
 * the motion lasts under five seconds). The guest's first scroll fades it out
 * for good; scrolling back to the top does not bring it back. Under reduced
 * motion the global clamp lands it at once, still.
 *
 * It takes the bottom 1.875rem of the hero (a 1rem offset under a 0.875rem
 * glyph; the drift moves it down, never up). A pack's hero keeps at least
 * 2.5rem of bottom padding beneath its title, so the two never meet.
 */
export function HeroScrollCue(props: HeroScrollCueProps) {
  const scrolled = createFirstScroll();

  return (
    <div
      aria-hidden="true"
      data-scroll-cue={scrolled() ? "hidden" : "shown"}
      // The hide lives here and the entry animation on the glyph: while the
      // entry applies (its delay included) it outranks a class, so on one
      // element a scroll in its first 1.6s could not fade it.
      class={`pointer-events-none absolute bottom-4 flex transition-opacity duration-500 ${ALIGN[props.align ?? "center"]} ${scrolled() ? "opacity-0" : "opacity-100"}`}
    >
      <svg
        viewBox="0 0 28 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-gold-ink animate-scroll-cue block h-3.5 w-7"
        // Inline, so it outranks the `animation` shorthand the utility writes
        // whatever order the stylesheet puts them in. A hidden cue runs
        // nothing.
        style={scrolled() ? { "animation-play-state": "paused" } : undefined}
      >
        <path d="M2 2 14 12 26 2" />
      </svg>
    </div>
  );
}
