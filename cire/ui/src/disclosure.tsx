import type { JSX } from "solid-js";

import { cardBoxClass } from "./card";

/**
 * A native `<details>`: a summary row that opens and closes the body beneath
 * it, a marker that turns as it opens, and the opening, a growth and a fade.
 *
 * Native, so it works with no script and from the keyboard (Enter or Space on
 * the summary), and the browser announces whether it is open. Both renderers
 * cire uses can draw it: a Solid screen renders it as any component, and an
 * Astro page renders it to static HTML with no `client:` directive, which is
 * all a `<details>` needs. A server-rendered one keeps `open`, `class` and
 * the markup; the two handlers exist only where Solid runs in the browser.
 *
 * ## Tones
 *
 * - `card`, the default: Card's box with the well fill, a leading `›` that
 *   turns a quarter as it opens. The summary row and the body pad themselves,
 *   so the whole row is the click target. On the page it takes the card's
 *   16px corner; `nested`, for one set inside another box, takes the small
 *   step. The summary has no corner of its own: its parent in the rendered
 *   tree is the details' internal slot, so `border-radius: inherit` would find
 *   none, and its focus ring is the square one every host disclosure draws.
 * - `rule`: a row with a hairline under it, a trailing `+` that turns into ×.
 *   An FAQ: the question in the display face, the answer beneath.
 *
 * The marker is the readable gold in both, and hidden from assistive
 * technology. It turns only with its own disclosure (`details[open] > summary
 * > marker`), so a closed one inside an open one stays closed. Its turn takes
 * the app's `--dur-fast`; each app's reduced-motion rule stops it.
 *
 * ## The opening
 *
 * As it opens, the box grows from its summary row to its full height while
 * the body drops 4px and fades in, all three on the app's `--dur-slow` and
 * `--ease-out`, so the text is never fully in while the box is still short,
 * nor faint in a box already full. A nested one grows the boxes round it on
 * the same frames, since theirs are `auto`, and a `createAutoSize` frame round
 * it follows the growth instead of animating it (`lib/auto-size.ts`, "A
 * disclosure that grows itself"). It closes at once: a fading body
 * would leave its controls focusable in a box that is going away.
 *
 * The body is clipped only while it grows, so no line spills past the box:
 * `overflow` moves from `clip` to `visible` on a zero-length step delayed by
 * the growth. Open and at rest, nothing inside is cut — a focus ring at the
 * body's edge, a row lifted by a drag.
 *
 * The transition is declared only on the open state, so closing has none to
 * run, and only inside `prefers-reduced-motion: no-preference`, because the
 * apps' reduced-motion rule selects `*`, which reaches no pseudo-element. The
 * growth needs `interpolate-size` (Chrome and Edge, not Safari or Firefox);
 * elsewhere the box opens at once and the body fades in it. An engine with
 * no `::details-content` opens the body at once. A disclosure that is open
 * when it first paints runs nothing.
 *
 * ## `open` and the two handlers
 *
 * `open` is the attribute: whether the disclosure starts open. The reader's
 * own toggles do not write back to it. `onToggle` reports every new state,
 * and the browser fires it for a script's change too — including on mount,
 * when `open` starts true. So a count of whether the reader has touched it
 * listens to `onSummaryClick`, the summary's own click, which a keyboard
 * press on the summary also fires.
 *
 * ## `class`
 *
 * Where it sits — a margin, a width, its place in a parent's flex or grid —
 * and nothing about how it looks, which the house lint refuses at a call site
 * (`shadcn/no-restyle`). A treatment one app owns, such as the host's
 * `attention-glow`, goes on an element wrapped round it.
 */

export type DisclosureTone = "card" | "rule";

interface ToneLook {
  /** The box, on the `<details>`; `nested` is the card's small corner. */
  box: (nested: boolean) => string;
  /** The summary row's padding, gap and type. */
  summary: string;
  glyph: string;
  /** The marker's turn, keyed to its own `<details>`. */
  turn: string;
  /** The body's inset. */
  body: string;
}

const TONES = {
  card: {
    box: (nested) => cardBoxClass({ fill: "well", nested }),
    summary: "base:gap-2 base:px-4 base:py-3 base:font-ui-body base:text-ui-base",
    glyph: "›",
    turn: "base:[details[open]>summary>&]:rotate-90",
    body: "base:px-4 base:pb-4",
  },
  rule: {
    box: () => "base:border-b base:border-ui-hairline",
    summary: "base:gap-4 base:py-4 base:font-ui-display base:text-ui-lg base:leading-ui-tight",
    glyph: "+",
    turn: "base:[details[open]>summary>&]:rotate-45",
    body: "base:pb-5",
  },
} satisfies Readonly<Record<DisclosureTone, ToneLook>>;

/**
 * The opening, on the body's slot. The fade and the 4px drop run wherever
 * `::details-content` does; the height and the clip are set only where
 * `interpolate-size` lets `height` move to `auto`. Without that gate the
 * transition's `allow-discrete` would step the height from 0 to `auto`
 * partway through; with it, such an engine never changes `height` or
 * `overflow`, so naming them in the transition does nothing there. The four
 * timings are in the transition's order: opacity, translate, height,
 * overflow.
 */
const OPENING =
  "motion-safe:base:details-content:opacity-0 motion-safe:base:details-content:-translate-y-1 " +
  "motion-safe:base:open:details-content:opacity-100 motion-safe:base:open:details-content:translate-none " +
  "motion-safe:base:supports-[interpolate-size:allow-keywords]:details-content:[interpolate-size:allow-keywords] " +
  "motion-safe:base:supports-[interpolate-size:allow-keywords]:details-content:h-0 " +
  "motion-safe:base:supports-[interpolate-size:allow-keywords]:details-content:overflow-clip " +
  "motion-safe:base:supports-[interpolate-size:allow-keywords]:open:details-content:h-auto " +
  "motion-safe:base:supports-[interpolate-size:allow-keywords]:open:details-content:overflow-visible " +
  "motion-safe:base:open:details-content:transition-[opacity,translate,height,overflow] " +
  "motion-safe:base:open:details-content:transition-discrete " +
  "motion-safe:base:open:details-content:duration-[var(--dur-slow,320ms),var(--dur-slow,320ms),var(--dur-slow,320ms),0s] " +
  "motion-safe:base:open:details-content:delay-[0s,0s,0s,var(--dur-slow,320ms)] " +
  "motion-safe:base:open:details-content:ease-out";

const SUMMARY_BASE =
  "base:flex base:items-center base:list-none base:cursor-pointer base:select-none " +
  "base:[&::-webkit-details-marker]:hidden base:text-ui-ink";

/** The summary's words take the rest of the row and wrap, so a long question never pushes the marker off. */
const LABEL = "base:min-w-0 base:flex-1 base:break-words";

const MARKER =
  "base:shrink-0 base:leading-none base:text-ui-accent-ink base:transition-[rotate] " +
  "base:duration-(--dur-fast,100ms) base:ease-out";

const BODY = "base:flex base:flex-col base:gap-3";

interface DisclosureCommon {
  /** The summary row's words. The marker is the part's own. */
  summary: JSX.Element;
  /** Whether it starts open. */
  open?: boolean;
  /** Every new state, a script's change and the mount included. */
  onToggle?: (open: boolean) => void;
  /** The summary's own click, the reader's touch. */
  onSummaryClick?: () => void;
  /** On the `<details>`, after the part's own: placement only. */
  class?: string;
  children: JSX.Element;
}

/** `nested` belongs to the card tone alone: a rule has no corner to change. */
export type DisclosureProps = DisclosureCommon &
  (
    | {
        tone?: "card";
        /** Set inside another box: the small corner. */
        nested?: boolean;
      }
    | { tone: "rule"; nested?: never }
  );

export default function Disclosure(props: DisclosureProps): JSX.Element {
  const look = () => TONES[props.tone ?? "card"];
  const marker = () => (
    <span aria-hidden="true" class={`${MARKER} ${look().turn}`}>
      {look().glyph}
    </span>
  );
  return (
    <details
      open={props.open}
      class={`${look().box(props.nested === true)} ${OPENING}${props.class ? ` ${props.class}` : ""}`}
      onToggle={(event) => props.onToggle?.(event.currentTarget.open)}
    >
      <summary class={`${SUMMARY_BASE} ${look().summary}`} onClick={() => props.onSummaryClick?.()}>
        {props.tone === "rule" ? null : marker()}
        <span class={LABEL}>{props.summary}</span>
        {props.tone === "rule" ? marker() : null}
      </summary>
      <div class={`${BODY} ${look().body}`}>{props.children}</div>
    </details>
  );
}
