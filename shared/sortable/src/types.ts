import type { Accessor } from "solid-js";

export type Id = string | number;

export interface DragTarget {
  id: Id;
  /** The registered node, so a collision detector can measure it. */
  node: HTMLElement;
}

/**
 * The shape `onDragStart` / `onDragOver` / `onDragEnd` receive.
 *
 * `droppable` is the item the pointer is currently OVER — for a sortable list
 * that means the row the dragged one would land on, and the move is a
 * splice-to-index rather than a swap. It is `null` before the pointer has
 * reached any registered item, and on a drop outside every list.
 */
export interface DragEvent {
  draggable: DragTarget;
  droppable: DragTarget | null;
}

export interface Transform {
  x: number;
  y: number;
}

export interface DragActivators {
  onPointerDown: (event: PointerEvent) => void;
}

export interface Sortable {
  /** Registers the node. Put this on the ROW, not on the handle. */
  ref: (el: HTMLElement) => void;
  /** The offset this row should paint at, or `null` when it is not moving. */
  transform: Accessor<Transform | null>;
  /**
   * Spread onto whatever should START a drag. Put it on a handle to keep the
   * row's own text selection and buttons working.
   *
   * Typed as exactly the handlers it supplies rather than as a broad
   * `HTMLAttributes`: the wide type carries a `ref?: HTMLElement` that clashes
   * with the narrower `ref` on whatever element it is spread onto.
   */
  dragActivators: DragActivators;
  /** True for the row currently being dragged. */
  isActiveDraggable: Accessor<boolean>;
}
