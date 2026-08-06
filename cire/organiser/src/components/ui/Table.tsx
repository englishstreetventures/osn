import { type ComponentProps, splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * The portal's five tables — guests, events, RSVPs, an import diff, a change
 * history — as one set of parts.
 *
 * ## The wrapper scrolls, the page does not
 *
 * A guest table with an email column is wider than a phone, and a table that
 * cannot be reached sideways is a table with a hidden column. The scroll lives
 * on the wrapper, so the body never scrolls sideways with it — which is the one
 * thing that makes a page feel broken rather than dense.
 *
 * That scroll has to be reachable from the keyboard. WebKit — most of this
 * product's traffic — does not make an overflow container focusable on its own,
 * so a host who does not use a mouse cannot reach the columns that are off the
 * edge. `tabindex="0"` gives it arrow keys; the labelled region is what stops
 * the new tab stop being an unexplained one on the way past.
 *
 * Which is why `label` is required rather than optional. A focusable box with no
 * name is worse than the bug it fixes, and every one of the five tables can say
 * in a word what it holds. A named `<section>` *is* a region, so the name does
 * both jobs and there is no `role` to write.
 *
 * `border-separate` with a zero spacing, rather than `border-collapse`: a
 * collapsed table hands its border to the cells, and the outer radius on the
 * wrapper then gets a square corner poking through it.
 */

export function Table(props: {
  /** Names the scroll region: "Guests", "Replies", "Changes". */
  label: string;
  class?: string;
  children: ComponentProps<"table">["children"];
}) {
  // oxlint-disable no-noninteractive-tabindex -- the rule is about static
  // content, and this box scrolls. Focusing it is what gives the arrow keys
  // somewhere to go; the name above is what makes the stop explicable. A
  // block rather than the next-line form because the attribute is not on the
  // line the element opens on, and oxfmt is what decides that.
  return (
    <section
      aria-label={props.label}
      tabindex="0"
      class={`border-border overflow-x-auto rounded-sm border${props.class ? ` ${props.class}` : ""}`}
    >
      <table class="w-full border-separate border-spacing-0 text-left">{props.children}</table>
    </section>
  );
  // oxlint-enable no-noninteractive-tabindex
}

export type ThProps = SafeProps<"th">;

/**
 * A column head. `scope="col"` by default — without it a screen reader has to
 * guess which cells a header governs, and in a wide table it guesses wrong.
 */
export function Th(props: ThProps) {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <th
      scope="col"
      {...rest}
      class={`font-body border-border text-gold border-b px-4 py-3 text-left text-[0.72rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase${
        own.class ? ` ${own.class}` : ""
      }`}
    />
  );
}

export type TdProps = SafeProps<"td"> & {
  /** Figures: right-aligned, tabular, so the digits line up down the column. */
  numeric?: boolean;
};

export function Td(props: TdProps) {
  const [own, rest] = splitProps(props, ["numeric", "class"]);
  return (
    <td
      {...rest}
      class={`border-border/40 text-text border-b px-4 py-3 text-[0.86rem] ${
        own.numeric ? "text-right font-mono tabular-nums" : ""
      }${own.class ? ` ${own.class}` : ""}`}
    />
  );
}
