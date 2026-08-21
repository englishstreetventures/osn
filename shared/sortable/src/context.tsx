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

interface DragState {
  active: Accessor<{ draggable: DragTarget | null; droppable: DragTarget | null }>;
  transform: Accessor<Transform | null>;
}

interface Registry {
  register: (id: Id, node: HTMLElement, group: symbol) => void;
  unregister: (id: Id) => void;
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

  const [active, setActive] = createSignal<{
    draggable: DragTarget | null;
    droppable: DragTarget | null;
  }>({ draggable: null, droppable: null });
  const [transform, setTransform] = createSignal<Transform | null>(null);

  const register = (id: Id, node: HTMLElement, group: symbol) => items.set(id, { node, group });
  const unregister = (id: Id) => items.delete(id);

  const groupTargets = (group: symbol): DragTarget[] =>
    [...items.entries()]
      .filter(([, v]) => v.group === group)
      .map(([id, v]) => ({ id, node: v.node }));

  function startDrag(id: Id, event: PointerEvent) {
    const entry = items.get(id);
    if (!entry) return;

    const draggable: DragTarget = { id, node: entry.node };
    const detect = props.collisionDetector ?? closestCenter;
    const origin = { x: event.clientX, y: event.clientY };
    let activated = false;
    let latest: DragEvent = { draggable, droppable: null };

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
        props.onDragOver?.(latest);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      setTransform(null);
      setActive({ draggable: null, droppable: null });
      // A press that never crossed the threshold was a click, not a drag. Firing
      // `onDragEnd` here would commit a no-op move on every handle click.
      if (activated) props.onDragEnd?.(latest);
    };

    const onCancel = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      setTransform(null);
      setActive({ draggable: null, droppable: null });
      // Deliberately no `onDragEnd`: a cancelled gesture (the OS taking over,
      // a context menu) is not a drop, and committing one would move a row the
      // user never released.
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  }

  return (
    <DragDropContext.Provider
      value={[
        { active, transform },
        { register, unregister, startDrag },
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
