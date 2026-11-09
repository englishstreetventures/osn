import { clsx } from "clsx";
import type { JSX } from "solid-js";

/**
 * "Something loads here." The block a list or a panel shows in place of each
 * line, row, field, button, card or chip while it loads, so the page holds its
 * shape and nothing jumps when the content lands.
 *
 * `standsFor` names what the block stands in for, and the block takes its
 * corner. Where the thing it stands in for reads a role corner, so does the
 * block, so it follows each app's mapping of that role:
 *
 * - `line` — a line of text: `rounded-ui-sm`.
 * - `row` — a list row: `rounded-ui-md`. The default, and the corner for any
 *   value it does not know: a value cast from stored data must not paint a
 *   block with no corner.
 * - `field` — a text field or a select: `rounded-ui-field`, the role `Input`
 *   and `Select` read.
 * - `control` — a button: `rounded-ui-control`, the role `Button` reads.
 * - `card` — a card: `rounded-ui-lg`.
 * - `pill` — a chip; an avatar when width and height match: `rounded-ui-pill`.
 *
 * Every block fills with the contract's sunk well (`bg-ui-surface-sunk`) at
 * full strength and draws no edge. Not `--ui-surface`: an app may map that to
 * its page colour, as Musubi does, and the block would vanish. In a contrast
 * theme (forced colours) the browser repaints every background as `Canvas`,
 * the page's own colour, so there the block draws a 1px edge, which the theme
 * paints in its own text colour, `CanvasText`. It does not opt out of the
 * repaint to fill with `currentColor`: that would take the page's text colour,
 * which can be the theme's `Canvas` when the two disagree on light or dark.
 *
 * It pulses on the theme's `--animate-pulse` (Tailwind's own token: down to
 * half strength and back over 2s), behind `motion-safe:`, so for a reader who
 * asked for reduced motion it stands still at full strength without the app
 * having a reduced-motion rule. An app that wants its own pace redefines
 * `--animate-pulse` in its `@theme`. No `--ui-*` motion token's job is a loop.
 *
 * `width` and `height` are spacing steps, computed as Tailwind's `w-n` and
 * `h-n` are (`48` is 12rem). It never runs wider than its container, a numeric
 * width does not shrink in a flex row (a square pill stays round), and no width
 * fills the container. A size that is not a finite number of at least 0 is
 * refused: the width fills the container and the height is one line of body
 * text (4 steps), rather than an invalid `calc()` that would draw nothing.
 *
 * It has no words and stands for nothing a screen reader should read, so it is
 * `aria-hidden` and takes no role. The region that holds both the skeletons and
 * the content that replaces them carries `aria-busy` while it loads; that is
 * the caller's.
 *
 * The caller's `class` carries only the block's place: a margin, a flex or grid
 * placement. Width and height are always inline, the full width included, so
 * a `w-*` or `h-*` passed there never resizes the block. No other prop reaches
 * the block, so no role, handler, title or child can.
 */

export type SkeletonStandIn = "line" | "row" | "field" | "control" | "card" | "pill";

const CORNER = {
  line: "base:rounded-ui-sm",
  row: "base:rounded-ui-md",
  field: "base:rounded-ui-field",
  control: "base:rounded-ui-control",
  card: "base:rounded-ui-lg",
  pill: "base:rounded-ui-pill",
} as const satisfies Readonly<Record<SkeletonStandIn, string>>;

/** The corner for `standsFor`, and a row's for anything else. `Object.hasOwn`, so `constructor` is not one. */
function corner(standsFor: SkeletonStandIn | undefined): string {
  // `String`, so a missing value is the key "undefined", which no corner has.
  return Object.hasOwn(CORNER, String(standsFor))
    ? CORNER[standsFor as SkeletonStandIn]
    : CORNER.row;
}

/** The height a refused `height` falls to: one line of body text. */
const LINE_STEPS = 4;

/** `n` spacing steps as Tailwind's `w-n` computes them, or nothing for a size it refuses. */
function steps(n: number | "full" | undefined): string | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? `calc(var(--spacing, 0.25rem) * ${n})`
    : undefined;
}

export interface SkeletonProps {
  /** What the block stands in for, which sets its corner. `row` when left out. */
  standsFor?: SkeletonStandIn;
  /** Spacing steps (`48` is `w-48`, 12rem), or `"full"`, the default: the container's width. */
  width?: number | "full";
  /** Spacing steps (`14` is `h-14`, 3.5rem). */
  height: number;
  /** The block's place only: a margin, a flex or grid placement. */
  class?: string;
}

export function Skeleton(props: SkeletonProps): JSX.Element {
  const width = () => steps(props.width);
  return (
    <div
      aria-hidden="true"
      class={clsx(
        "base:bg-ui-surface-sunk base:max-w-full base:motion-safe:animate-pulse base:forced-colors:border",
        corner(props.standsFor),
        width() !== undefined && "base:shrink-0",
        props.class,
      )}
      style={{ width: width() ?? "100%", height: steps(props.height) ?? steps(LINE_STEPS) }}
    />
  );
}
