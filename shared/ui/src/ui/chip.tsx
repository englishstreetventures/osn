import type { JSX } from "solid-js";

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
 * The tints are light on purpose. A chip's word is small text, held to 4.5:1
 * on what it sits on, and a stronger wash darkens the ground under a coloured
 * word on a pale theme: `success`, `pending` and `accent` fill at 8%, `danger`
 * at 10%, `neutral` with the surface at 60%. `cire/host`'s
 * `tests/styles/chip-contrast.browser.test.tsx` measures every tone and
 * variant on cire's grounds in both themes.
 *
 * `caps`, the default, is a status word in small caps: `uppercase`, the wider
 * letter-spacing, held to one line. `tag` is a label as written — a vendor's
 * category, "Cash fund", a run sheet's "Coming up" — in sentence case at
 * normal spacing and a step narrower, free to wrap like the text it is.
 *
 * An outline or a tag may lead with a mark — a dot, an icon — and holds it
 * 6px from the word. A filled small-caps chip holds its word alone.
 *
 * ## Colour is never the only carrier
 *
 * The chip's text *is* the state — "live", "quoted" — so the hue is decoration
 * on top of a word that already says it. That is why this takes `children` and
 * not just a `tone`: a chip with a tone and no text is a colour nobody can name.
 *
 * ## Danger is outlined unless asked
 *
 * Filled `danger`'s 10% tint reads 4.01:1 on cire's pale page with its red, and
 * no wash of that red reaches the 4.5:1 a small word needs, so a `danger` chip
 * with no `variant` is outlined (4.59:1). The filled one stays for a ground
 * that measures it.
 *
 * ## What reaches the element
 *
 * A chip is a label, not a control, and its word is the state. So it takes an
 * allow-list rather than a span's props: an `id`, `aria-describedby`, `data-*`
 * attributes, and `role="status"` for a chip whose word changes under the
 * reader. Nothing else — no handler, no `title` (a badge that needs explaining
 * sits in `Tooltip`, and a `title` hands a screen reader the explanation
 * twice), no `aria-hidden`, `hidden` or `aria-label` that would hide or replace
 * the word, no markup — reaches the `<span>`, whether typed or spread from an
 * untyped object. A chip that has to be pressed is a `Button`.
 */

export type ChipTone = "neutral" | "success" | "pending" | "accent" | "danger";

export type ChipVariant = "filled" | "outline";

export type ChipTreatment = "caps" | "tag";

const LOOK = {
  caps: {
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
    success: "base:bg-ui-success/8 base:text-ui-success",
    /** Waiting on someone. */
    pending: "base:bg-ui-warn/8 base:text-ui-warn",
    /** Progressed, but not finished — the state worth drawing the eye to. */
    accent: "base:bg-ui-accent/8 base:text-ui-accent-ink",
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

export type ChipProps = {
  tone?: ChipTone;
  variant?: ChipVariant;
  treatment?: ChipTreatment;
  /** Layout only: where the chip sits, never how it looks. */
  class?: string;
  id?: string;
  /** A polite live region, for a chip whose word changes under the reader. */
  role?: "status";
  "aria-describedby"?: string;
  children: JSX.Element;
} & { [attribute: `data-${string}`]: string | boolean | undefined };

type DataAttribute = `data-${string}`;

/** A `data-*` attribute name: lower-case letters, digits and hyphens. */
function isDataAttribute(key: string): key is DataAttribute {
  return /^data-[a-z0-9-]+$/.test(key);
}

export function Chip(props: ChipProps) {
  const data = () => {
    const out: Partial<Record<DataAttribute, string | boolean>> = {};
    for (const key of Object.keys(props)) {
      if (!isDataAttribute(key)) continue;
      const value = props[key];
      if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    }
    return out;
  };
  const tone = (): ChipTone =>
    props.tone && Object.hasOwn(TONE.filled, props.tone) ? props.tone : "neutral";
  const variant = (): ChipVariant => {
    if (props.variant && Object.hasOwn(TONE, props.variant)) return props.variant;
    return tone() === "danger" ? "outline" : "filled";
  };
  const treatment = (): ChipTreatment =>
    props.treatment && Object.hasOwn(LOOK, props.treatment) ? props.treatment : "caps";
  return (
    <span
      {...data()}
      id={props.id}
      role={props.role === "status" ? "status" : undefined}
      aria-describedby={props["aria-describedby"]}
      class={`${LOOK[treatment()][variant()]} ${TONE[variant()][tone()]}${props.class ? ` ${props.class}` : ""}`}
    >
      {props.children}
    </span>
  );
}
