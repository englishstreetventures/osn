import {
  createContext,
  createMemo,
  onCleanup,
  type JSX,
  type ParentProps,
  useContext,
} from "solid-js";

import { useDragDropContext } from "./context";
import type { Id, Sortable, Transform } from "./types";

/**
 * Identifies one sortable list. Collision detection never crosses a group, so
 * several lists on a page stay independent without any extra wiring.
 */
const GroupContext = createContext<symbol>();

/**
 * One sortable list. `ids` is the list's order, and is load-bearing twice over:
 * it scopes collision detection to this list, and it is what lets the provider
 * work out which rows sit between the dragged one and its target, so they can
 * shift aside to open the gap.
 */
export function SortableProvider(props: ParentProps<{ ids: Id[] }>) {
  const ctx = useDragDropContext();
  if (!ctx) throw new Error("<SortableProvider> must be used inside a <DragDropProvider>");
  const [, registry] = ctx;

  // One identity per provider instance, so two lists never share a group.
  const group = Symbol("sortable-group");
  registry.registerGroup(group, () => props.ids);
  onCleanup(() => registry.unregisterGroup(group));

  return <GroupContext.Provider value={group}>{props.children}</GroupContext.Provider>;
}

/**
 * Wire one row into the drag.
 *
 * Put `ref` on the ROW and spread `dragActivators` onto the HANDLE. That split
 * is the point: making the whole row the drag affordance swallows text
 * selection and the row's own buttons.
 *
 * Because `ref` only registers the node, the row must paint its own offset —
 * `style={maybeTransformStyle(sortable.transform())}`.
 */
export function createSortable(id: Id): Sortable {
  const ctx = useDragDropContext();
  if (!ctx) throw new Error("createSortable must be used inside a <DragDropProvider>");
  const [state, registry] = ctx;
  const group = useContext(GroupContext);
  if (!group) throw new Error("createSortable must be used inside a <SortableProvider>");

  const isActiveDraggable = createMemo(() => state.active().draggable?.id === id);

  onCleanup(() => registry.unregister(id));

  return {
    ref: (el: HTMLElement) => registry.register(id, el, group),
    transform: createMemo((): Transform | null => {
      // The dragged row tracks the pointer.
      if (isActiveDraggable()) return state.transform();
      // Everything between it and the drop target shifts by one row to open the
      // gap — that preview is what makes a drop legible before it happens.
      // `0` means "not displaced", and must stay `null` so the row writes no
      // transform at all rather than an identity one.
      const dy = state.displacement(id);
      return dy === 0 ? null : { x: 0, y: dy };
    }),
    isActiveDraggable,
    dragActivators: {
      onPointerDown: (event: PointerEvent) => {
        // Left button / primary contact only — a right-click or a middle-click
        // is not a drag, and starting one steals the context menu.
        if (event.button !== 0) return;
        registry.startDrag(id, event);
      },
    },
  };
}

/**
 * The style map for a row's current offset.
 *
 * Returns `{}` rather than an identity `translate(0, 0)` when there is no
 * transform: writing one anyway would make every row a containing block and a
 * stacking context for its own descendants, permanently, for the sake of a
 * no-op.
 */
export function maybeTransformStyle(transform: Transform | null): JSX.CSSProperties {
  if (!transform) return {};
  return { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` };
}
