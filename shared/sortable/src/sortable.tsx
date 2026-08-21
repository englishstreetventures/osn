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

export function SortableProvider(props: ParentProps<{ ids: Id[] }>) {
  // One identity per provider instance. `props.ids` is not used to key anything
  // — it exists so the call site reads as a declaration of the list's contents,
  // and so a future virtualised variant has the full order available.
  const group = Symbol("sortable-group");
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
    transform: createMemo(() => (isActiveDraggable() ? state.transform() : null)),
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
