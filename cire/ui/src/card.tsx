import type { JSX } from "solid-js";

/**
 * cire's rectangle.
 *
 * One border, one radius, one padding, everywhere — the Overview grid, the
 * settings panels, the listing form, an enquiry in the inbox. The variants are
 * deliberately few: a card earns the gold rule only by being the loudest thing
 * on its screen, and everything else is the neutral one.
 *
 * ## Why the classes are exported too
 *
 * Some cards are `<div>`s and some are `<button>`s that jump to a module, and a
 * `<div role="button">` is a worse answer than either. So the classes are
 * available on their own for the call sites that need a different element, and
 * the component covers the ordinary case. Both read the same strings — Tailwind
 * scans source as text, so a literal inside a function is a literal it finds.
 */

export type CardTone = "default" | "accent";

const CARD_BASE = "base:flex base:flex-col base:gap-3 base:rounded-ui-sm base:border base:p-5";

const TONE = {
  default: "base:border-ui-hairline base:bg-ui-surface/30",
  accent: "base:border-ui-accent/30 base:bg-ui-surface/30",
} satisfies Readonly<Record<CardTone, string>>;

/** Added when the whole card is the control. */
const INTERACTIVE =
  "base:hover:border-ui-accent-soft base:hover:bg-ui-surface/50 base:text-left " +
  "base:transition-colors base:duration-200 base:ease-out";

export function cardClass(options: { tone?: CardTone; interactive?: boolean } = {}): string {
  return `${CARD_BASE} ${TONE[options.tone ?? "default"]}${
    options.interactive ? ` ${INTERACTIVE}` : ""
  }`;
}

export default function Card(props: { tone?: CardTone; class?: string; children: JSX.Element }) {
  return (
    <div class={`${cardClass({ tone: props.tone })}${props.class ? ` ${props.class}` : ""}`}>
      {props.children}
    </div>
  );
}

/** The gold label a card leads with. One weight, one tracking, everywhere. */
export function CardEyebrow(props: { children: JSX.Element }) {
  return (
    <p class="base:font-ui-body base:text-ui-accent base:text-ui-xs base:tracking-ui-ultra base:uppercase">
      {props.children}
    </p>
  );
}

/**
 * The "go to the module" line at the foot of a card.
 *
 * The arrow is `aria-hidden` and nudges on hover — the movement is the whole
 * point of the detail, and each app's reduced-motion rule disarms the
 * transition without the arrow disappearing.
 */
export function CardCta(props: { children: JSX.Element }) {
  return (
    <span class="base:font-ui-body base:text-ui-accent-ink base:hover:text-ui-accent group/cta base:flex base:items-center base:gap-1.5 base:self-start base:text-ui-sm base:transition-colors base:duration-100">
      {props.children}
      <span
        aria-hidden="true"
        class="base:transition-transform base:duration-200 base:ease-out base:group-hover/cta:translate-x-1"
      >
        →
      </span>
    </span>
  );
}

/**
 * The same line, when it is the thing you press.
 *
 * `CardCta` is a `<span>`, because on most cards the whole card is the control
 * and a nested button inside it would be a second tab stop over the same
 * destination. Where the card is NOT a button — a card whose body is a chart or
 * a list, with one action underneath — the line has to be the control itself,
 * and every such call site was writing the same `<button type="button"
 * class="self-start">` wrapper by hand.
 *
 * The `self-start` belongs on the button, not the span: a flex child stretches
 * to the column's width by default, so without it the hit area runs the full
 * width of the card and a click anywhere along that line fires it.
 */
export function CardCtaButton(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button type="button" class="base:cursor-pointer base:self-start" onClick={props.onClick}>
      <CardCta>{props.children}</CardCta>
    </button>
  );
}
