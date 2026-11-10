import { createMemo, Show, type JSX } from "solid-js";

/**
 * A block that opens to its own height when `when` turns true, and closes at
 * once when it turns false.
 *
 * ## Why the wrapper is always mounted
 *
 * A transition needs two states on one element, and an element that has just
 * been inserted has only one. Solid's `<Show>` inserts the content, so a
 * transition declared on the content itself would need `@starting-style` to
 * have anything to start from — and it would then also run on the very first
 * paint, animating a field that was open before the sheet was.
 *
 * So the grid wrapper is permanent and only the content is conditional. The
 * wrapper's `grid-template-rows` moves `0fr → 1fr` on an element that was
 * already there, which is an ordinary transition with no starting rule, and a
 * wrapper that mounts already open mounts at `1fr` and simply is open.
 *
 * ## Why `0fr`/`1fr` rather than a height
 *
 * `1fr` resolves to the content's own height, so nothing measures anything and
 * no JavaScript runs. `interpolate-size: allow-keywords` with `height: auto`
 * says the same thing more directly, but is not yet in every engine these apps
 * are opened in.
 *
 * ## Why the close is instant
 *
 * An exit transition means keeping the content in the document while the box
 * around it collapses — and this wraps form fields, so that is a focusable
 * input inside a box of zero height, which a guest can tab into and not see.
 * The content unmounts the moment `when` turns false; the empty wrapper
 * finishes closing behind it.
 *
 * The `prefers-reduced-motion` clamp each app declares globally turns the open
 * into a step change, which is why there is no branch for it here.
 *
 * ## Why the wrapper clips, not the row
 *
 * Mid-transition, Chrome sizes a row of `p·fr` against the wrapper's own height,
 * which is already `p` of the content's: the row is `p²` of it. A clip on the
 * row would show the content lagging the box, with an empty band under it.
 * The wrapper's edge is the one that moves with `p`, so the clip is there and
 * the row's box clips nothing.
 *
 * ## Why the clip has 4px of room
 *
 * The wrapper is 4px bigger than the content on every side, and a matching
 * negative margin keeps it in the content's place. The house focus outline is
 * 2px wide and 2px out, so a field or a pill at the content's edge keeps its
 * whole ring. Closed, the wrapper takes no pointer events: its empty box still
 * reaches 4px past each edge, and at opacity 0 it paints above its neighbours.
 */
export interface RevealProps {
  /** Open when true. Also gates whether the children are in the document. */
  when: boolean;
  /**
   * The rung of the app's ladder the opening runs on: `base`, the default, for
   * someone at work in a portal; `slow` for a reader, the guest site, where
   * the owner asked that the opening be felt.
   */
  pace?: "base" | "slow";
  children: JSX.Element;
}

export default function Reveal(props: RevealProps): JSX.Element {
  /**
   * `when` is read once per change, not three times.
   *
   * A Solid JSX prop compiles to a getter, so each read re-runs whatever
   * expression the caller wrote. The RSVP sheet's is
   * `presets.includes("other") || dietary.trim().length > 0` against a signal
   * holding the whole household — replaced on every keystroke in any member's
   * field. Three reads there is three `includes` over sixteen presets and three
   * `trim()` copies of up to 500 characters per member per character typed.
   */
  const open = createMemo(() => props.when);

  return (
    // `overflow-clip` rather than `hidden` so the hidden half of the content
    // cannot be scrolled to: both axes clip, so this is not a scroll
    // container. `-m-1 p-1`: the ring's room.
    <div
      class="-m-1 grid overflow-clip p-1 transition-[grid-template-rows,opacity] ease-out"
      classList={{
        "duration-(--dur-base,200ms)": props.pace !== "slow",
        "duration-(--dur-slow,320ms)": props.pace === "slow",
        "grid-rows-[1fr] opacity-100": open(),
        "grid-rows-[0fr] opacity-0 pointer-events-none": !open(),
      }}
    >
      {/* `min-h-0` so the row may resolve smaller than the content — a grid
          item's automatic minimum size is its content, which would pin the
          track open at `0fr`; `min-w-0` for the same reason across, or a
          scrolling track inside widens the column to every item in it instead
          of scrolling. */}
      <div class="min-h-0 min-w-0">
        <Show when={open()}>{props.children}</Show>
      </div>
    </div>
  );
}
