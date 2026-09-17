import type { JSX } from "solid-js";

/**
 * A small pill that names a state: a listing that is live or a draft, an
 * enquiry that is open, quoted or closed.
 *
 * The two call sites it replaces were two different chips — one at `px-3 py-1`
 * and `0.72rem`, the other at `px-2 py-0.5` and `0.68rem`, which put the same
 * idea at two sizes on two screens the same person moves between.
 *
 * ## The tones are contract roles, not raw palette
 *
 * Both call sites reached for fixed Tailwind palette values
 * (`bg-green-500/15 text-green-400`, `bg-blue-500/10 text-blue-400`). Those are
 * fixed sRGB: they do not move when the theme flips, so a blue chip that reads
 * on a dark ground is a bright smear on a light one. These are contract tokens,
 * so they follow whatever the app maps.
 *
 * ## The names are roles, not domains
 *
 * `success`/`pending`/`accent` rather than `live`/`active`/`quoted`. A shared
 * component cannot know that "quoted" is a state a vendor puts an enquiry in;
 * an app maps its own word onto the role at the call site, which is also what
 * stops a second product needing a second set of tones.
 *
 * ## Colour is never the only carrier
 *
 * The chip's text *is* the state — "live", "quoted" — so the hue is decoration
 * on top of a word that already says it. That is why this takes `children` and
 * not just a `tone`: a chip with a tone and no text is a colour nobody can name.
 */

export type ChipTone = "neutral" | "success" | "pending" | "accent";

const BASE =
  "base:font-ui-body base:inline-flex base:shrink-0 base:items-center base:rounded-ui-pill " +
  "base:px-2.5 base:py-0.5 base:text-ui-xs base:tracking-ui-wider base:whitespace-nowrap base:uppercase";

const TONE = {
  /** Nothing has happened yet: a draft, a closed thread. */
  neutral: "base:bg-ui-surface/60 base:text-ui-ink-secondary",
  /** Done, published, confirmed. */
  success: "base:bg-ui-success/12 base:text-ui-success",
  /** Waiting on someone. */
  pending: "base:bg-ui-warn/12 base:text-ui-warn",
  /** Progressed, but not finished — the state worth drawing the eye to. */
  accent: "base:bg-ui-accent-soft base:text-ui-accent-ink",
} satisfies Readonly<Record<ChipTone, string>>;

export function Chip(props: { tone?: ChipTone; children: JSX.Element }) {
  return <span class={`${BASE} ${TONE[props.tone ?? "neutral"]}`}>{props.children}</span>;
}
