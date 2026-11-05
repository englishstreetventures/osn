import { children, type JSX, type ResolvedJSXElement } from "solid-js";

/** Marks a run of words; the outline's CSS draws it as a bar. */
const RUN = "data-skeleton-run";

/** A run is drawn only where it holds a letter or a digit. */
const WORDS = /[\p{L}\p{N}]/u;

/**
 * Text that is not a run of words on the page, and must not move: a glyph's,
 * a form control's own content (an option's label, a text box's value), a
 * stylesheet's.
 */
const NOT_A_RUN = "svg, option, textarea, script, style, title";

const ELEMENT_NODE = 1;

function needsRun(text: Text): boolean {
  const parent = text.parentElement;
  return WORDS.test(text.data) && !parent?.hasAttribute(RUN) && !parent?.closest(NOT_A_RUN);
}

function wrap(text: Text): HTMLSpanElement {
  const run = document.createElement("span");
  run.setAttribute(RUN, "");
  text.parentNode?.replaceChild(run, text);
  run.append(text);
  return run;
}

/**
 * One resolved child, with each run of words inside it in a span of its own.
 * A string or number child becomes its run here, since Solid would otherwise
 * insert it as bare text; nothing (`false`, `null`) passes through. Read by
 * `nodeType`, not `instanceof`.
 */
function markRuns(child: ResolvedJSXElement): ResolvedJSXElement {
  if (typeof child === "string" || typeof child === "number") {
    const text = document.createTextNode(String(child));
    return needsRun(text) ? wrap(text) : text;
  }
  if ((child as Partial<Node> | null)?.nodeType === ELEMENT_NODE) {
    const walker = document.createTreeWalker(child as Element, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (needsRun(text as Text)) found.push(text as Text);
    }
    for (const text of found) wrap(text);
  }
  return child;
}

/*
 * The outline's look, as literal Tailwind (each cire app's build scans
 * `@cire/ui/src`; the package ships no CSS). `!` where a part's own utility
 * would otherwise win: a button's fill, border and shadow, a glyph's fill.
 *
 * A block is a button, an input, a select, a text box, the track after a
 * switch's hidden input, or anything marked `data-skeleton="block"`, unless it
 * is marked `data-skeleton="text"`. The pulse is `lib/pulse.ts`'s, written
 * out because a class built at run time emits no CSS.
 */
const OUTLINE = [
  // No glyph is painted (the property is inherited) and nothing is selected.
  "select-none [-webkit-text-fill-color:transparent]",
  // No underline, text shadow or placeholder on any part.
  "**:decoration-transparent! **:text-shadow-none! **:placeholder:text-transparent!",
  // A run: a bar per line, rounded at both ends of each.
  "**:data-skeleton-run:bg-ui-ink/10 **:data-skeleton-run:rounded-[4px] **:data-skeleton-run:box-decoration-clone",
  // A block: one fill, no edge or shadow, nothing of what it holds.
  "**:[&:is(button,input,select,textarea,[role=switch]+span,[data-skeleton=block]):not([data-skeleton=text])]:bg-ui-ink/10!",
  "**:[&:is(button,input,select,textarea,[role=switch]+span,[data-skeleton=block]):not([data-skeleton=text])]:bg-none!",
  "**:[&:is(button,input,select,textarea,[role=switch]+span,[data-skeleton=block]):not([data-skeleton=text])]:border-transparent!",
  "**:[&:is(button,input,select,textarea,[role=switch]+span,[data-skeleton=block]):not([data-skeleton=text])]:shadow-none!",
  "[&_:is(button,input,select,textarea,[role=switch]+span,[data-skeleton=block]):not([data-skeleton=text])_*]:invisible!",
  // A glyph: a small block, its strokes hidden.
  "[&_svg]:bg-ui-ink/10! [&_svg]:rounded-[4px]! [&_svg_*]:invisible!",
  // The pulse, on the bars, blocks and glyphs alone: frames and grounds hold still.
  "**:[&:is([data-skeleton-run],svg,button,input,select,textarea,[role=switch]+span,[data-skeleton=block]):not([data-skeleton=text])]:animate-[pulse_calc(2s*var(--motion-scale,1))_var(--ease-in-out,var(--ui-ease-in-out))_infinite]",
].join(" ");

export interface SkeletonOutlineProps {
  /** The view's own markup, rendered from a typed sample, in its own layout. */
  children: JSX.Element;
}

/**
 * "Something like this goes here." The loading placeholder that is the real
 * row drawn hollow (englishstreetventures/osn#1955, the owner's Q6 C and Q7 C):
 * a view renders its own markup from a typed sample inside this, and the
 * outline paints it as a skeleton, so the placeholder takes the loaded row's
 * height at every width with no height written down.
 *
 * What it draws:
 *
 * - each run of words or digits a bar the height of its letters, one per
 *   wrapped line, with a 4px corner at both ends of every line
 *   (`box-decoration-break: clone`). Text with no letter or digit — a dot or a
 *   dash between words — draws nothing, and paints no glyph;
 * - a boxed control one block: a button, an input, a select, a text box, a
 *   switch's track, and anything marked `data-skeleton="block"` (a status
 *   disc, a chip). What a block holds is hidden. A button drawn as words, such
 *   as a sortable column head, is marked `data-skeleton="text"`;
 * - a glyph (`svg`) a small block with the same 4px corner;
 * - frames, hairlines and grounds as they are, and still: only the bars, the
 *   blocks and the glyphs pulse.
 *
 * Every bar, block and glyph is the ink at 10%, which reads on the page and on
 * the surface alike, and pulses on the loaders' timing (`lib/pulse.ts`: 2s ×
 * `--motion-scale` on `--ease-in-out`); each app's reduced-motion rule stops
 * it without this module knowing.
 *
 * How: each run of words is moved, once, into an inline `<span
 * data-skeleton-run>` as the children arrive, and CSS does the rest. Most text
 * in a row is bare inside a block (`td`, `dt`, `p`), where no selector can
 * reach it to give it an inline background, and a struck-through line instead
 * cannot round its ends and darkens once for each box it is nested in.
 * Nothing is measured: the browser wraps, sizes and re-wraps every bar on a
 * resize or a font load as it does the text.
 *
 * The children are a still picture: they are rendered once, from constant
 * samples. A run that appears later inside them, under a `Show` that flips
 * after the outline mounts, is not drawn; a layout that changes renders a new
 * outline (a `Show` around it, or a top-level child that changes, which is
 * marked again).
 *
 * `aria-hidden` and `inert`, so nothing inside is read, focused or pressed;
 * the region around it carries `aria-busy`. It takes no class: the children
 * bring their own layout, as the loaded content's wrapper has it.
 */
export default function SkeletonOutline(props: SkeletonOutlineProps) {
  const resolved = children(() => props.children);
  return (
    <div data-skeleton-outline aria-hidden="true" inert class={OUTLINE}>
      {resolved.toArray().map(markRuns)}
    </div>
  );
}
