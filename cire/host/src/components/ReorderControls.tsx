import Button from "@cire/ui/button";
import type { Sortable, SortableItem } from "@shared/sortable";

/**
 * The reorder controls at the start of a sortable row: a grip to drag or to move
 * with the arrow keys, and a "move up" / "move down" pair for screen readers.
 *
 * The pair is not redundant. NVDA and JAWS in browse mode keep the arrow keys
 * for their own cursor, so a screen-reader user reaches the grip's key handler
 * only through buttons activated with Enter or Space. They are visually hidden
 * until focused, so a sighted keyboard user never lands on an invisible control.
 *
 * `size="icon"` on a borderless button carries the 24px minimum target, so no
 * size class belongs on the grip; `ReorderControls.browser.test.tsx` measures it.
 */
export default function ReorderControls(props: {
  /** The row's `createSortable`, for the pointer drag. */
  sortable: Sortable;
  /** The row's slice of `createSortableList` — the grip's label, keys and focus. */
  item: SortableItem;
}) {
  const moveButton = (delta: -1 | 1) => (
    <Button
      variant="primary"
      size="sm"
      {...props.item.moveProps(delta)}
      class="sr-only focus:not-sr-only focus:relative focus:z-20"
    >
      {props.item.moveLabel(delta)}
    </Button>
  );

  return (
    <div class="flex shrink-0 items-center">
      <Button
        variant="bare"
        size="icon"
        // `dragActivators` FIRST: later props win in a spread, and `gripProps`
        // carries the key handler, the label and the ref focus returns to.
        {...props.sortable.dragActivators}
        {...props.item.gripProps()}
        class="cursor-grab touch-none active:cursor-grabbing"
      >
        ⠿
      </Button>
      <span class="flex flex-col">
        {moveButton(-1)}
        {moveButton(1)}
      </span>
    </div>
  );
}
