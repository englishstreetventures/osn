import type { JSX } from "solid-js";

import { cardBoxClass } from "./card";

/**
 * A native `<details>`: a summary row that opens and closes the body beneath
 * it, a marker that turns as it opens, and the opening fade.
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
 *   16px corner; one nested in another box takes the small step from its
 *   caller (`class="rounded-sm"`). The summary has no corner of its own: its
 *   parent in the rendered tree is the details' internal slot, so
 *   `border-radius: inherit` would find none, and its focus ring is the square
 *   one every host disclosure draws.
 * - `rule`: a row with a hairline under it, a trailing `+` that turns into ×.
 *   An FAQ: the question in the display face, the answer beneath.
 *
 * The marker is the readable gold in both, and hidden from assistive
 * technology. It turns only with its own disclosure (`details[open] > summary
 * > marker`), so a closed one inside an open one stays closed. Its turn takes
 * the app's `--dur-fast`; each app's reduced-motion rule stops it.
 *
 * ## The fade
 *
 * The body drops 4px and fades in as it opens, and closes at once: a fading
 * body would leave its controls focusable in a box that is going away. The
 * transition is declared only on the open state, so closing has none to run,
 * and only inside `prefers-reduced-motion: no-preference`, because the apps'
 * reduced-motion rule selects `*`, which reaches no pseudo-element. An engine
 * with no `::details-content` opens the body at once. A disclosure that is
 * open when it first paints does not fade.
 *
 * ## `open` and the two handlers
 *
 * `open` is the attribute: whether the disclosure starts open. The reader's
 * own toggles do not write back to it. `onToggle` reports every new state,
 * and the browser fires it for a script's change too — including on mount,
 * when `open` starts true. So a count of whether the reader has touched it
 * listens to `onSummaryClick`, the summary's own click, which a keyboard
 * press on the summary also fires.
 */

export type DisclosureTone = "card" | "rule";

interface ToneLook {
  /** The box, on the `<details>`. */
  box: string;
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
    box: cardBoxClass({ fill: "well" }),
    summary: "base:gap-2 base:px-4 base:py-3 base:font-ui-body base:text-ui-base",
    glyph: "›",
    turn: "base:[details[open]>summary>&]:rotate-90",
    body: "base:px-4 base:pb-4",
  },
  rule: {
    box: "base:border-b base:border-ui-hairline",
    summary: "base:gap-4 base:py-4 base:font-ui-display base:text-ui-lg base:leading-ui-tight",
    glyph: "+",
    turn: "base:[details[open]>summary>&]:rotate-45",
    body: "base:pb-5",
  },
} satisfies Readonly<Record<DisclosureTone, ToneLook>>;

const FADE =
  "motion-safe:base:details-content:opacity-0 motion-safe:base:details-content:-translate-y-1 " +
  "motion-safe:base:open:details-content:opacity-100 motion-safe:base:open:details-content:translate-none " +
  "motion-safe:base:open:details-content:transition-[opacity,translate] " +
  "motion-safe:base:open:details-content:duration-(--dur-base,200ms) " +
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

export interface DisclosureProps {
  /** The summary row's words. The marker is the part's own. */
  summary: JSX.Element;
  tone?: DisclosureTone;
  /** Whether it starts open. */
  open?: boolean;
  /** Every new state, a script's change and the mount included. */
  onToggle?: (open: boolean) => void;
  /** The summary's own click, the reader's touch. */
  onSummaryClick?: () => void;
  /** On the `<details>`, after the part's own. */
  class?: string;
  children: JSX.Element;
}

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
      class={`${look().box} ${FADE}${props.class ? ` ${props.class}` : ""}`}
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
