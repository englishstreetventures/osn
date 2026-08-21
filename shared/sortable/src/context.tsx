import { createContext, createSignal, type Accessor, type ParentProps, useContext } from "solid-js";

import { closestCenter } from "./collision";
import type { DragEvent, DragTarget, Id, Transform } from "./types";

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Not decoration: without it a plain click on the handle starts and ends a
 * drag, and any list where the handle is also a button loses the button. The
 * events list's tests press without moving and assert the order is untouched.
 */
export const ACTIVATION_DISTANCE = 4;

type Detector = (
  draggable: DragTarget,
  droppables: DragTarget[],
  pointer: { x: number; y: number },
) => DragTarget | null;

export interface DragState {
  active: Accessor<{ draggable: DragTarget | null; droppable: DragTarget | null }>;
  /** The dragged row's offset from where it started. `null` when nothing is dragging. */
  transform: Accessor<Transform | null>;
  /** How far a NON-dragged row has been pushed to open the gap. 0 for most rows. */
  displacement: (id: Id) => number;
}

export interface Registry {
  register: (id: Id, node: HTMLElement, group: symbol) => void;
  unregister: (id: Id) => void;
  registerGroup: (group: symbol, ids: Accessor<Id[]>) => void;
  unregisterGroup: (group: symbol) => void;
  startDrag: (id: Id, event: PointerEvent) => void;
}

const DragDropContext = createContext<[DragState, Registry]>();

export function useDragDropContext() {
  return useContext(DragDropContext);
}

export interface DragDropProviderProps {
  onDragStart?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDragEnd?: (event: DragEvent) => void;
  collisionDetector?: Detector;
}

/**
 * Owns one drag gesture and the set of items that can take part in it.
 *
 * ## Groups, and why multi-container is nearly free
 *
 * Every item registers with the `SortableProvider` it sits under, identified by
 * a `symbol`. Collision detection only ever considers items sharing the
 * dragged item's group, so N lists on one page are N independent sortables
 * with no cross-talk — a task dragged inside "3 months out" cannot land in
 * "1 month out", which is right, because moving between buckets is a
 * re-bucketing (a semantic change), not a re-order.
 *
 * That also means one `DragDropProvider` can wrap several lists.
 */
export function DragDropProvider(props: ParentProps<DragDropProviderProps>) {
  const items = new Map<Id, { node: HTMLElement; group: symbol }>();
  /** A group's declared order, from its `SortableProvider`'s `ids`. */
  const groups = new Map<symbol, Accessor<Id[]>>();

  const [active, setActive] = createSignal<{
    draggable: DragTarget | null;
    droppable: DragTarget | null;
  }>({ draggable: null, droppable: null });
  const [transform, setTransform] = createSignal<Transform | null>(null);
  const [displaced, setDisplaced] = createSignal<Map<Id, number>>(new Map());

  const register = (id: Id, node: HTMLElement, group: symbol) => items.set(id, { node, group });
  const unregister = (id: Id) => items.delete(id);
  const registerGroup = (group: symbol, ids: Accessor<Id[]>) => groups.set(group, ids);
  const unregisterGroup = (group: symbol) => groups.delete(group);

  const groupTargets = (group: symbol): DragTarget[] =>
    [...items.entries()]
      .filter(([, v]) => v.group === group)
      .map(([id, v]) => ({ id, node: v.node }));

  /**
   * The distance one row occupies along the list, INCLUDING the gap to the next
   * one — measured rather than assumed, because the gap lives in the consumer's
   * CSS and a package that guessed it would open a hole of the wrong size.
   *
   * Taken from the first adjacent pair rather than from one row's height. For a
   * uniform list (which is every list here) that is exact; for a ragged one it
   * is an approximation, which is the same trade every sortable library makes.
   */
  function strideFor(group: symbol): number {
    const ids = groups.get(group)?.() ?? [];
    const rects = ids
      .map((id) => items.get(id)?.node.getBoundingClientRect())
      .filter((r): r is DOMRect => !!r);
    if (rects.length < 2) return rects[0]?.height ?? 0;
    return Math.abs(rects[1]!.top - rects[0]!.top);
  }

  /**
   * Push the rows between the dragged one and its target out of the way, so the
   * list previews the drop instead of only moving the row under the pointer.
   *
   * Dragging DOWN from `from` to `to` pulls every row in `(from, to]` up by one
   * stride; dragging UP pushes every row in `[to, from)` down by one. The
   * dragged row itself is excluded — it tracks the pointer.
   */
  function computeDisplacement(group: symbol, fromId: Id, toId: Id | null): Map<Id, number> {
    const out = new Map<Id, number>();
    if (toId === null) return out;
    const ids = groups.get(group)?.() ?? [];
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from === -1 || to === -1 || from === to) return out;

    const stride = strideFor(group);
    if (stride === 0) return out;

    if (from < to) {
      for (let i = from + 1; i <= to; i++) out.set(ids[i]!, -stride);
    } else {
      for (let i = to; i < from; i++) out.set(ids[i]!, stride);
    }
    return out;
  }

  const displacement = (id: Id) => displaced().get(id) ?? 0;

  function startDrag(id: Id, event: PointerEvent) {
    const entry = items.get(id);
    if (!entry) return;

    const draggable: DragTarget = { id, node: entry.node };
    const detect = props.collisionDetector ?? closestCenter;
    const origin = { x: event.clientX, y: event.clientY };
    let activated = false;
    let latest: DragEvent = { draggable, droppable: null };

    const reset = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      setTransform(null);
      setDisplaced(new Map());
      setActive({ draggable: null, droppable: null });
    };

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;

      if (!activated) {
        if (Math.hypot(dx, dy) < ACTIVATION_DISTANCE) return;
        activated = true;
        setActive({ draggable, droppable: null });
        props.onDragStart?.({ draggable, droppable: null });
      }

      setTransform({ x: dx, y: dy });
      const droppable = detect(draggable, groupTargets(entry.group), {
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
      // Only a CHANGE of slot is worth reporting: the pointer emits a stream of
      // events inside one row, and a consumer ticking a haptic per event would
      // buzz continuously instead of once per row crossed.
      if (droppable?.id !== latest.droppable?.id) {
        latest = { draggable, droppable };
        setActive({ draggable, droppable });
        setDisplaced(computeDisplacement(entry.group, id, droppable?.id ?? null));
        props.onDragOver?.(latest);
      }
    };

    const onUp = () => {
      reset();
      // A press that never crossed the threshold was a click, not a drag. Firing
      // `onDragEnd` here would commit a no-op move on every handle click.
      if (activated) props.onDragEnd?.(latest);
    };

    // Deliberately no `onDragEnd`: a cancelled gesture (the OS taking over, a
    // context menu) is not a drop, and committing one would move a row the user
    // never released.
    const onCancel = () => reset();

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  }

  return (
    <DragDropContext.Provider
      value={[
        { active, transform, displacement },
        { register, unregister, registerGroup, unregisterGroup, startDrag },
      ]}
    >
      {props.children}
    </DragDropContext.Provider>
  );
}

/**
 * Registers the pointer sensor.
 *
 * Kept as a component rather than folded into the provider so the call site
 * reads the same as the library this replaced, and so a future keyboard or
 * touch sensor can be opted into the same way. It renders nothing.
 */
export function DragDropSensors() {
  return null;
}
