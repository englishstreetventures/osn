import { createMemo, onCleanup } from "solid-js";

import { FREE_GROUP, useDragDropContext } from "./context";
import { sameTransform } from "./sortable";
import type { Droppable, Id, Sortable, Transform } from "./types";

/**
 * A free item: one that is dragged INTO a drop zone rather than re-ordered
 * within a list — a guest onto a table. Same shape as `createSortable`, and
 * wired the same way: `ref` on the item, `dragActivators` on its handle, and
 * the item paints its own offset with `maybeTransformStyle(transform())`.
 *
 * It needs no `SortableProvider`. While one is dragged, the provider measures
 * the zones (`createDroppable`) instead of a list, reports the zone the pointer
 * is inside as the drop target (`null` between zones), and pushes nothing
 * aside. Sortable rows under the same provider never see a free item, and a
 * free item never sees them.
 *
 * The keyboard and screen-reader path is the consumer's: choosing a container
 * is a choice from a list, which a menu or a native `<select>` already does
 * completely — there is no arrow-key equivalent of "drop on the third table"
 * worth inventing.
 */
export function createDraggable(id: Id): Sortable {
  const ctx = useDragDropContext();
  if (!ctx) throw new Error("createDraggable must be used inside a <DragDropProvider>");
  const [state, registry] = ctx;
  const isActiveDraggable = () => state.isDragged(id);

  let node: HTMLElement | undefined;
  onCleanup(() => registry.unregister(id, node));

  return {
    ref: (el: HTMLElement) => {
      node = el;
      registry.register(id, el, FREE_GROUP);
    },
    transform: createMemo(
      (): Transform | null => (isActiveDraggable() ? state.transform() : null),
      undefined,
      { equals: sameTransform },
    ),
    isActiveDraggable,
    dragActivators: {
      onPointerDown: (event: PointerEvent) => {
        // Primary button only, as for a sortable row.
        if (event.button !== 0) return;
        registry.startDrag(id, event);
      },
    },
  };
}

/**
 * A drop zone for free items. Put `ref` on the container; `isOver` is true
 * while a free item is dragged over it, for the highlight that says where a
 * release would land.
 *
 * Zones are kept apart from list items, so a zone may share its id with a
 * sortable row — a table can be both a row of a list of tables and a place to
 * drop a guest.
 */
export function createDroppable(id: Id): Droppable {
  const ctx = useDragDropContext();
  if (!ctx) throw new Error("createDroppable must be used inside a <DragDropProvider>");
  const [state, registry] = ctx;
  let node: HTMLElement | undefined;
  onCleanup(() => registry.unregisterZone(id, node));
  return {
    ref: (el: HTMLElement) => {
      node = el;
      registry.registerZone(id, el);
    },
    isOver: () => state.isOver(id),
  };
}
