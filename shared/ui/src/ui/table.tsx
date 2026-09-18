import { splitProps, type ComponentProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * A data table, as three parts: the scrolling frame, a column head and a cell.
 *
 * ## The wrapper scrolls, the page does not
 *
 * A guest table with an email column is wider than a phone, and a table that
 * cannot be reached sideways is a table with a hidden column. The scroll lives
 * on the wrapper, so the body never scrolls sideways with it — which is the one
 * thing that makes a page feel broken rather than dense.
 *
 * That scroll has to be reachable from the keyboard. WebKit does not make an
 * overflow container focusable on its own, so somebody who does not use a mouse
 * cannot reach the columns that are off the edge. `tabindex="0"` gives it arrow
 * keys; the labelled region is what stops the new tab stop being an unexplained
 * one on the way past.
 *
 * Which is why `label` is required rather than optional. A focusable box with no
 * name is worse than the bug it fixes, and any table can say in a word what it
 * holds. A named `<section>` *is* a region, so the name does both jobs and there
 * is no `role` to write.
 *
 * `border-separate` with zero spacing, rather than `border-collapse`: a
 * collapsed table hands its border to the cells, and the outer radius on the
 * wrapper then gets a square corner poking through it.
 */
export interface TableProps {
  /** Names the scroll region: "Guests", "Replies", "Changes". */
  label: string;
  class?: string;
  children: ComponentProps<"table">["children"];
}

export function Table(props: TableProps) {
  // oxlint-disable no-noninteractive-tabindex -- the rule is about static
  // content, and this box scrolls. Focusing it is what gives the arrow keys
  // somewhere to go; the name above is what makes the stop explicable. A
  // block rather than the next-line form because the attribute is not on the
  // line the element opens on, and oxfmt is what decides that.
  return (
    <section
      aria-label={props.label}
      tabindex="0"
      class={`base:border-ui-hairline base:overflow-x-auto base:rounded-ui-sm base:border${props.class ? ` ${props.class}` : ""}`}
    >
      <table class="base:font-ui-body base:w-full base:border-separate base:border-spacing-0 base:text-left">
        {props.children}
      </table>
    </section>
  );
  // oxlint-enable no-noninteractive-tabindex
}

/**
 * Where a cell's contents sit across the column.
 *
 * A prop rather than a passed `text-center`, because that would fight the
 * component's own `text-left` on the same property — and two Tailwind utilities
 * on one property resolve by stylesheet order, not by the order they appear in
 * `class`, so the call site's does not reliably win.
 */
export type CellAlign = "start" | "center" | "end";

const ALIGN = {
  start: "base:text-left",
  center: "base:text-center",
  end: "base:text-right",
} satisfies Readonly<Record<CellAlign, string>>;

/**
 * `Omit<…, "align">` because `<th>` and `<td>` both carry a deprecated native
 * `align` attribute typed `"left" | "center" | "right" | …`. Intersecting
 * rather than omitting it silently narrows the prop to the one value the two
 * unions share — `"center"` — so `align="end"` becomes a type error with a
 * baffling message. The same collision `Input`'s `size` has.
 */
export type ThProps = Omit<SafeProps<"th">, "align"> & {
  /** {@link CellAlign}. `end` for a column of figures, `center` for checkboxes or icons. */
  align?: CellAlign;
};

/**
 * A column head. `scope="col"` by default — without it a screen reader has to
 * guess which cells a header governs, and in a wide table it guesses wrong.
 */
export function Th(props: ThProps) {
  const [own, rest] = splitProps(props, ["align", "class"]);
  return (
    <th
      scope="col"
      {...rest}
      class={`base:font-ui-body base:border-ui-hairline base:text-ui-accent-ink base:border-b base:px-4 base:py-3 ${
        ALIGN[own.align ?? "start"]
      } base:text-ui-xs base:font-normal base:tracking-ui-wider base:whitespace-nowrap base:uppercase${
        own.class ? ` ${own.class}` : ""
      }`}
    />
  );
}

export type TdProps = Omit<SafeProps<"td">, "align"> & {
  /**
   * Figures: right-aligned, tabular, so the digits line up down the column.
   * Shorthand for `align="end"` plus the mono face, because those three always
   * travel together on a number.
   */
  numeric?: boolean;
  /** {@link CellAlign}. Ignored when `numeric` is set, which already means `end`. */
  align?: CellAlign;
  /**
   * An opaque identifier — a public ID, a hash, a reference code. Mono face and
   * wide tracking, which is what makes a run of look-alike characters readable
   * without turning it into a number: unlike {@link TdProps.numeric} it does
   * not right-align, because an identifier is not a quantity and lining its
   * last character up with the one above says nothing.
   */
  code?: boolean;
  /**
   * A row nested under the one above it — a household member under the
   * household. The indent is the cell's rather than a wrapper's so it applies
   * to the cell's whole box, including its hover and selection fill.
   */
  indent?: boolean;
  /** `muted` for a cell that is context rather than content — a timestamp, a note. */
  tone?: "default" | "muted";
  /**
   * `middle` for a row whose cells differ in height — one holding a control,
   * its neighbour a single word. The default is the browser's, which is
   * baseline, and that is right for a row of plain text.
   */
  valign?: "baseline" | "middle";
};

const TD_TONE = {
  default: "base:text-ui-ink",
  muted: "base:text-ui-ink-secondary",
} as const;

export function Td(props: TdProps) {
  const [own, rest] = splitProps(props, [
    "numeric",
    "code",
    "indent",
    "align",
    "tone",
    "valign",
    "class",
  ]);
  return (
    <td
      {...rest}
      class={`base:border-ui-hairline/40 base:border-b base:px-4 base:py-3 base:text-ui-base ${
        TD_TONE[own.tone ?? "default"]
      } ${own.valign === "middle" ? "base:align-middle" : ""} ${
        own.indent ? "base:pl-8" : ""
      } ${own.code ? "base:font-ui-mono base:tracking-ui-wide" : ""} ${
        own.numeric
          ? "base:text-right base:font-ui-mono base:tabular-nums"
          : ALIGN[own.align ?? "start"]
      }${own.class ? ` ${own.class}` : ""}`}
    />
  );
}
