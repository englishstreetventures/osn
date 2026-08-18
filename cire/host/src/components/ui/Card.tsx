import type { JSX } from "solid-js";

/**
 * The dashboard's rectangle.
 *
 * One border, one radius, one padding, everywhere — the Overview grid, the
 * settings panels, the vendor list. The variants are deliberately few: a card
 * earns the gold rule only by being the loudest thing on its screen (the
 * countdown), and everything else is the neutral one.
 *
 * ## Why a class function and a component
 *
 * Some cards are `<div>`s and some are `<button>`s that jump to a module, and a
 * `<div role="button">` is a worse answer than either. So the classes are
 * available on their own for the call sites that need a different element, and
 * the component covers the ordinary case. Both read the same strings — Tailwind
 * scans source as text, so a literal inside a function is a literal it finds.
 */

export type CardTone = "default" | "accent";

const CARD_BASE = "flex flex-col gap-3 rounded-sm border p-5";

const TONE = {
  default: "border-border bg-surface/30",
  accent: "border-gold/30 bg-surface/30",
} satisfies Readonly<Record<CardTone, string>>;

/** Added when the whole card is the control. */
const INTERACTIVE =
  "hover:border-gold-dim hover:bg-surface/50 text-left transition-colors duration-(--dur-base) ease-(--ease-out)";

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
    <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">{props.children}</p>
  );
}

/**
 * The "go to the module" line at the foot of a card.
 *
 * The arrow is `aria-hidden` and nudges on hover — the movement is the whole
 * point of the detail, and the reduced-motion switch in `global.css` disarms the
 * transition without the arrow disappearing.
 */
export function CardCta(props: { children: JSX.Element }) {
  return (
    <span class="font-body text-gold-dim hover:text-gold group/cta flex items-center gap-1.5 self-start text-[0.78rem] transition-colors duration-(--dur-fast)">
      {props.children}
      <span
        aria-hidden="true"
        class="transition-transform duration-(--dur-base) ease-(--ease-out) group-hover/cta:translate-x-1"
      >
        →
      </span>
    </span>
  );
}
