/**
 * The top bar's wordmark: "✦ Cire", the way home in both portals.
 *
 * A button with a hover wash and no frame — the nav-row highlight at the 6px
 * step that the portals' menus and module rail also draw — named by `label`
 * alone ("Cire — all weddings", "Cire — your listings"), because a mark that
 * navigates and does not say so is a trap for anyone not looking at it. The
 * star and the word are `aria-hidden`, so neither leaks into that name.
 *
 * ## The star
 *
 * Readable gold (`--ui-accent-ink`), at rest and under the pointer. Gold text
 * is always readable gold (the owner's rule); `--ui-accent` is gold as metal,
 * about 2.4:1 on cire's light ground. The hover changes only the wash.
 *
 * ## The box
 *
 * It pulls 4px left (`-ml-1`), so the star sits on the page frame's edge while
 * the wash still has room around it, and never right: the focus ring is the
 * house ring, 2px at a 2px offset, and with a pull on the right too it would
 * land on the divider (or vendor's tabs) 8px along the bar's row. Left only,
 * it clears them by 4px (owner, Stack 6 question 40, A2).
 *
 * Its own ring, from the contract's focus token, as `Button` draws one: a
 * library part cannot count on its app declaring a blanket `:focus-visible`.
 * Only the wash fades, on the app's `--dur-fast` and `--ease-out`; the
 * transition names its property, so the ring lands at once.
 *
 * ## The copy in the boot bar
 *
 * `WordmarkPlaceholder` is the same box and glyphs with nothing to press: no
 * role, no tab stop, no hover, `aria-hidden`. Each portal's `index.astro`
 * paints it in the static bar that stands in for the top bar until the island
 * mounts, and renders it to HTML with no client directive. Both share `BOX`
 * and `Glyphs`, so the island's swap moves nothing. It is a second export
 * rather than a prop, so the still copy can never turn into a control.
 *
 * No `class`, `size` or `variant`: both bars draw the same mark in the same
 * place.
 */

/** The box both share: the left pull, the row, the 6px corner, the padding. */
const BOX =
  "base:-ml-1 base:flex base:shrink-0 base:items-center base:gap-2 base:rounded-ui-sm " +
  "base:px-1.5 base:py-1.5";

/** What only the button adds: the wash, the ring, and the wash's fade. */
const CONTROL =
  "base:hover:bg-ui-surface/60 " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus " +
  "base:transition-[background-color] base:duration-(--dur-fast,100ms) " +
  "base:ease-(--ease-out) base:motion-reduce:transition-none";

function Glyphs() {
  return (
    <>
      <span aria-hidden="true" class="base:text-ui-accent-ink base:text-ui-sm base:leading-none">
        ✦
      </span>
      <span
        aria-hidden="true"
        class="base:font-ui-display base:text-ui-ink base:text-ui-md base:tracking-ui-wide base:leading-ui-none base:font-light"
      >
        Cire
      </span>
    </>
  );
}

export default function Wordmark(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={() => props.onClick()}
      class={`${BOX} ${CONTROL}`}
    >
      <Glyphs />
    </button>
  );
}

export function WordmarkPlaceholder() {
  return (
    <span aria-hidden="true" class={BOX}>
      <Glyphs />
    </span>
  );
}
