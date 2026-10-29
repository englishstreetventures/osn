import type { JSX } from "solid-js";

/*
 * cire's rectangle.
 *
 * One border and one radius everywhere — the Overview grid, the settings
 * panels, the listing form, an enquiry in the inbox — and a few named steps of
 * padding, fill and border colour, so a card that needs more room or no ground
 * asks for a step instead of being drawn by hand. The steps are deliberately
 * few: a card earns the gold rule only by being the loudest thing on its
 * screen, and everything else is the neutral one.
 *
 * ## Why the classes are exported too
 *
 * Some cards are `<div>`s and some are `<button>`s that jump to a module, and a
 * `<div role="button">` is a worse answer than either. So the classes are
 * available on their own for the call sites that need a different element, and
 * the component covers the ordinary case. Both read the same strings — Tailwind
 * scans source as text, so a literal inside a function is a literal it finds.
 */

/**
 * How much room a card gives its contents.
 *
 * `md` is the default because it is the one step every card had before the
 * others existed. `sm` is a filter bar or a small card in a list, `lg` a panel
 * that holds a whole form, and `xl` the sign-in card, alone on its page. The
 * steps are `@shared/ui` Card's (`sm`, `md`, `lg`) plus `xl`; that card has a
 * `none` default as well, because its header and content parts pad
 * themselves, and this one has no parts that do.
 */
export type CardPadding = "sm" | "md" | "lg" | "xl";

const PADDING = {
  sm: "base:p-4",
  md: "base:p-5",
  lg: "base:p-6",
  xl: "base:p-8",
} satisfies Readonly<Record<CardPadding, string>>;

/**
 * What the card is filled with.
 *
 * - `wash`, the default: the surface at 30%, so the page shows through and a
 *   grid of cards reads as one layer.
 * - `well`: the sunk surface, for a box that holds something already on the
 *   page rather than introducing it — a preview, a diff. `@shared/ui` Card
 *   calls the same fill `muted`. On the guest site and the marketing site the
 *   sunk surface is the page's own ground, so there a well is told apart by
 *   its border alone.
 * - `opaque`: the surface itself, for a card that stands alone on its page and
 *   must not let anything behind it through — the sign-in card.
 * - `none`: no ground, for a card set on something that already has one — a
 *   row in a list, a box inside a panel.
 */
export type CardFill = "wash" | "well" | "opaque" | "none";

const FILL = {
  wash: "base:bg-ui-surface/30",
  well: "base:bg-ui-surface-sunk",
  opaque: "base:bg-ui-surface",
  none: "",
} satisfies Readonly<Record<CardFill, string>>;

/**
 * The border, which is all a tone changes.
 *
 * `accent` is the gold rule, for the loudest card on its screen. `danger` is
 * the red one, for the card that holds an action nobody can undo — the danger
 * zone at the foot of the settings.
 */
export type CardTone = "default" | "accent" | "danger";

const TONE = {
  default: "base:border-ui-hairline",
  accent: "base:border-ui-accent/30",
  danger: "base:border-ui-danger/30",
} satisfies Readonly<Record<CardTone, string>>;

const CARD_BASE = "base:flex base:flex-col base:gap-3 base:rounded-ui-lg base:border";

/**
 * Added when the whole card is the control.
 *
 * The transition names only what a hover changes: Tailwind's
 * `transition-colors` also fades `outline-color`, which would bring the focus
 * ring in over the hover's duration. The duration is the app's `--dur-fast`;
 * the fallback is for an app that declares no motion ladder.
 */
const INTERACTIVE =
  "base:hover:border-ui-accent-soft base:hover:bg-ui-surface/50 base:text-left " +
  "base:transition-[color,background-color,border-color,text-decoration-color] " +
  "base:duration-(--dur-fast,100ms) base:ease-out";

/** How a card looks: each option has a default, so `{}` is the ordinary card. */
interface CardLook {
  padding?: CardPadding;
  fill?: CardFill;
  tone?: CardTone;
}

/**
 * `cardClass`'s options.
 *
 * `interactive` is accepted only on the wash fill and a tone other than
 * `danger`. Its hover lifts the wash to 50% and turns the border gold: no other
 * fill has a lifted step to go to, and a danger card holds a control rather
 * than being one. So the type refuses the pairs that would have no hover,
 * whether `interactive` is written `true` or passed as a `boolean`.
 */
export type CardOptions =
  | (CardLook & { interactive?: false })
  | {
      padding?: CardPadding;
      fill?: "wash";
      tone?: "default" | "accent";
      interactive: true;
    };

export function cardClass(options: CardOptions = {}): string {
  const fill = FILL[options.fill ?? "wash"];
  return `${CARD_BASE} ${PADDING[options.padding ?? "md"]} ${TONE[options.tone ?? "default"]}${
    fill ? ` ${fill}` : ""
  }${options.interactive ? ` ${INTERACTIVE}` : ""}`;
}

/**
 * A card's box alone: its corner, its border in the tone's colour, and the
 * fill, with no padding and no layout.
 *
 * For a part that pads its own pieces rather than the box — a disclosure,
 * whose summary row is the whole click target. It repeats `CARD_BASE`'s
 * corner and border rather than composing it, because `cardClass()` with no
 * options is pinned and puts its padding between the border and its colour.
 */
export function cardBoxClass(options: { fill?: CardFill; tone?: CardTone } = {}): string {
  const fill = FILL[options.fill ?? "wash"];
  return `base:rounded-ui-lg base:border ${TONE[options.tone ?? "default"]}${fill ? ` ${fill}` : ""}`;
}

/**
 * The card as a `<div>`.
 *
 * It takes how the card looks and nothing about whether it is a control: a
 * `<div>` with the interactive hover would promise a click nothing answers. A
 * card that is the control is a `<button>` or an `<a>` wearing
 * `cardClass({ interactive: true })`.
 */
export default function Card(props: CardLook & { class?: string; children: JSX.Element }) {
  return (
    <div
      class={`${cardClass({ padding: props.padding, fill: props.fill, tone: props.tone })}${
        props.class ? ` ${props.class}` : ""
      }`}
    >
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
 * transition without the arrow disappearing. The label's colour takes the
 * app's `--dur-fast`, a hover, and the arrow's nudge `--dur-base`, a short
 * slide; each falls back to its own duration in an app with no motion ladder.
 */
export function CardCta(props: { children: JSX.Element }) {
  return (
    <span class="base:font-ui-body base:text-ui-accent-ink base:hover:text-ui-accent group/cta base:flex base:items-center base:gap-1.5 base:self-start base:text-ui-sm base:transition-[color,background-color,border-color,text-decoration-color] base:duration-(--dur-fast,100ms)">
      {props.children}
      <span
        aria-hidden="true"
        class="base:transition-transform base:duration-(--dur-base,200ms) base:ease-out base:group-hover/cta:translate-x-1"
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
