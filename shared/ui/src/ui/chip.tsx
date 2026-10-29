import { type JSX, splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * A small pill that names a state: a listing that is live or a draft, an
 * enquiry that is open, quoted or closed, a guest's reply, a section shown or
 * hidden.
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
 * `success`/`pending`/`accent`/`danger` rather than `live`/`active`/`quoted`/
 * `declined`. A shared component cannot know that "quoted" is a state a vendor
 * puts an enquiry in; an app maps its own word onto the role at the call site,
 * which is also what stops a second product needing a second set of tones.
 *
 * ## Two variants, two treatments
 *
 * `filled`, the default, is a tinted ground and no border. `outline` is a 1px
 * border at 40% of the tone (the hairline for `neutral`) and no ground, at the
 * filled chip's height: the border takes the place of a pixel of padding.
 *
 * `caps`, the default, is a status word in small caps: `uppercase`, the wider
 * letter-spacing, held to one line. `tag` is a label as written — a vendor's
 * category, "Cash fund", a run sheet's "Coming up" — in sentence case at
 * normal spacing and a step narrower, free to wrap like the text it is.
 *
 * An outline or a tag may lead with a mark — a dot, an icon — and holds it
 * 6px from the word. A filled small-caps chip holds its word alone, which keeps
 * its class list the one every app drew before the variants existed.
 *
 * ## Colour is never the only carrier
 *
 * The chip's text *is* the state — "live", "quoted" — so the hue is decoration
 * on top of a word that already says it. That is why this takes `children` and
 * not just a `tone`: a chip with a tone and no text is a colour nobody can name.
 *
 * ## No `title`
 *
 * A badge whose meaning is not obvious sits inside `Tooltip`; a `title` would
 * hand a screen reader the explanation a second time and show nothing on touch.
 * So `title` is not a prop, and one spread onto a chip is dropped.
 */

export type ChipTone = "neutral" | "success" | "pending" | "accent" | "danger";

export type ChipVariant = "filled" | "outline";

export type ChipTreatment = "caps" | "tag";

const LOOK = {
  caps: {
    /** The chip every app drew before the variants existed, byte for byte. */
    filled:
      "base:font-ui-body base:inline-flex base:shrink-0 base:items-center base:rounded-ui-pill " +
      "base:px-2.5 base:py-0.5 base:text-ui-xs base:tracking-ui-wider base:whitespace-nowrap base:uppercase",
    outline:
      "base:font-ui-body base:inline-flex base:shrink-0 base:items-center base:gap-1.5 " +
      "base:rounded-ui-pill base:border base:px-2.5 base:py-px base:text-ui-xs base:tracking-ui-wider " +
      "base:whitespace-nowrap base:uppercase",
  },
  tag: {
    filled:
      "base:font-ui-body base:inline-flex base:items-center base:gap-1.5 base:rounded-ui-pill " +
      "base:px-2 base:py-0.5 base:text-ui-xs",
    outline:
      "base:font-ui-body base:inline-flex base:items-center base:gap-1.5 base:rounded-ui-pill " +
      "base:border base:px-2 base:py-px base:text-ui-xs",
  },
} satisfies Readonly<Record<ChipTreatment, Readonly<Record<ChipVariant, string>>>>;

const TONE = {
  filled: {
    /** Nothing has happened yet: a draft, a closed thread. */
    neutral: "base:bg-ui-surface/60 base:text-ui-ink-secondary",
    /** Done, published, confirmed. */
    success: "base:bg-ui-success/12 base:text-ui-success",
    /** Waiting on someone. */
    pending: "base:bg-ui-warn/12 base:text-ui-warn",
    /** Progressed, but not finished — the state worth drawing the eye to. */
    accent: "base:bg-ui-accent-soft base:text-ui-accent-ink",
    /** Gone or refused: declined, withdrawn, no longer available. */
    danger: "base:bg-ui-danger/10 base:text-ui-danger",
  },
  outline: {
    neutral: "base:border-ui-hairline base:text-ui-ink-secondary",
    success: "base:border-ui-success/40 base:text-ui-success",
    pending: "base:border-ui-warn/40 base:text-ui-warn",
    accent: "base:border-ui-accent/40 base:text-ui-accent-ink",
    danger: "base:border-ui-danger/40 base:text-ui-danger",
  },
} satisfies Readonly<Record<ChipVariant, Readonly<Record<ChipTone, string>>>>;

export type ChipProps = Omit<SafeProps<"span">, "title" | "children"> & {
  tone?: ChipTone;
  variant?: ChipVariant;
  treatment?: ChipTreatment;
  children: JSX.Element;
};

/** The attribute `ChipProps` leaves out, which an untyped spread could still carry. */
interface Withheld {
  title?: unknown;
}

export function Chip(props: ChipProps) {
  const withheld: ChipProps & Withheld = props;
  const [own, , rest] = splitProps(
    withheld,
    ["tone", "variant", "treatment", "class", "children"],
    ["title"],
  );
  const tone = (): ChipTone =>
    own.tone && Object.hasOwn(TONE.filled, own.tone) ? own.tone : "neutral";
  const variant = (): ChipVariant =>
    own.variant && Object.hasOwn(TONE, own.variant) ? own.variant : "filled";
  const treatment = (): ChipTreatment =>
    own.treatment && Object.hasOwn(LOOK, own.treatment) ? own.treatment : "caps";
  return (
    <span
      {...rest}
      class={`${LOOK[treatment()][variant()]} ${TONE[variant()][tone()]}${own.class ? ` ${own.class}` : ""}`}
    >
      {own.children}
    </span>
  );
}
