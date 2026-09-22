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
 */
export interface RevealProps {
  /** Open when true. Also gates whether the children are in the document. */
  when: boolean;
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
    <div
      class="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
      classList={{
        "grid-rows-[1fr] opacity-100": open(),
        "grid-rows-[0fr] opacity-0": !open(),
      }}
    >
      {/* `min-h-0` so the row may resolve smaller than the content — a grid
          item's automatic minimum size is its content, which would pin the
          track open at `0fr`. `overflow-clip` rather than `hidden` so the
          hidden half of the content cannot be scrolled to: both axes clip, so
          this is not a scroll container. */}
      <div class="min-h-0 overflow-clip">
        <Show when={open()}>{props.children}</Show>
      </div>
    </div>
  );
}
