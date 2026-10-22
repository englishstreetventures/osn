/**
 * The small marks the run sheet and a checklist row's time are drawn with. Each
 * is decorative: a word beside it says the same thing. Stroked in
 * `currentColor`, so a mark takes the ink of the label it sits in.
 */

interface GlyphProps {
  /** The box, e.g. `size-3`. */
  class: string;
}

/** A time: a clock face. */
export function ClockGlyph(props: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      class={`shrink-0 ${props.class}`}
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

/** Done: a tick. */
export function TickGlyph(props: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      class={`shrink-0 ${props.class}`}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m3.5 8.25 3 3 6-6.5" />
    </svg>
  );
}

/** Follows an event: two links of a chain. */
export function LinkGlyph(props: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      class={`shrink-0 ${props.class}`}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.1-2.1a2.75 2.75 0 0 0-3.9-3.9l-.6.6" />
      <path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2.1 2.1a2.75 2.75 0 0 0 3.9 3.9l.6-.6" />
    </svg>
  );
}

/** Its event was removed: the chain, broken and struck. */
export function UnlinkGlyph(props: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      class={`shrink-0 ${props.class}`}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <path d="M9.5 3.6 10.1 3a2.75 2.75 0 0 1 3.9 3.9l-2.1 2.1" />
      <path d="M6.5 12.4l-.6.6A2.75 2.75 0 0 1 2 9.1L4.1 7" />
      <path d="M2.5 2.5l11 11" />
    </svg>
  );
}
