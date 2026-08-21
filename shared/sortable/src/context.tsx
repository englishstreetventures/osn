import {
  createContext,
  createSignal,
  onCleanup,
  type Accessor,
  type ParentProps,
  useContext,
} from "solid-js";

import { closestCenter } from "./collision";
import type { DragEvent, DragTarget, Id, MeasuredTarget, Transform } from "./types";

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
  droppables: MeasuredTarget[],
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

  /**
   * Measure a group ONCE, in the order its `SortableProvider` declares.
   *
   * Declared order rather than Map insertion order: items register as they
   * mount, so after a re-order the Map no longer reflects the list, and both
   * the stride and the displacement range depend on knowing which rows sit
   * between two others.
   */
  function measure(group: symbol): MeasuredTarget[] {
    const ids = groups.get(group)?.() ?? [];
    const out: MeasuredTarget[] = [];
    for (const id of ids) {
      const entry = items.get(id);
      if (entry) out.push({ id, node: entry.node, rect: entry.node.getBoundingClientRect() });
    }
    return out;
  }

  /**
   * The distance one row occupies along the list, INCLUDING the gap to the next
   * one — measured rather than assumed, because the gap lives in the consumer's
   * CSS and a package that guessed it would open a hole of the wrong size.
   *
   * Taken from the first adjacent pair. For a uniform list (which is every list
   * here) that is exact; for a ragged one it is an approximation, which is the
   * same trade every sortable library makes.
   */
  function strideOf(measured: MeasuredTarget[]): number {
    if (measured.length < 2) return measured[0]?.rect.height ?? 0;
    return Math.abs(measured[1]!.rect.top - measured[0]!.rect.top);
  }

  /**
   * Push the rows between the dragged one and its target out of the way, so the
   * list previews the drop instead of only moving the row under the pointer.
   *
   * Dragging DOWN from `from` to `to` pulls every row in `(from, to]` up by one
   * stride; dragging UP pushes every row in `[to, from)` down by one. The
   * dragged row itself is excluded — it tracks the pointer.
   */
  function computeDisplacement(
    measured: MeasuredTarget[],
    stride: number,
    fromId: Id,
    toId: Id | null,
  ): Map<Id, number> {
    const out = new Map<Id, number>();
    if (toId === null || stride === 0) return out;
    const order = measured.map((m) => m.id);
    const from = order.indexOf(fromId);
    const to = order.indexOf(toId);
    if (from === -1 || to === -1 || from === to) return out;

    if (from < to) {
      for (let i = from + 1; i <= to; i++) out.set(order[i]!, -stride);
    } else {
      for (let i = to; i < from; i++) out.set(order[i]!, stride);
    }
    return out;
  }

  const displacement = (id: Id) => displaced().get(id) ?? 0;

  /** Tears down whatever gesture is live. Set by `startDrag`, cleared by it. */
  let endGesture: (() => void) | null = null;

  // A gesture that is still live when the provider unmounts would otherwise
  // leave three document listeners behind, firing into a disposed scope — and
  // the next `pointerup` anywhere would call the consumer's `onDragEnd` with
  // stale indices, committing a reorder nobody made.
  onCleanup(() => endGesture?.());

  function startDrag(id: Id, event: PointerEvent) {
    const entry = items.get(id);
    if (!entry) return;

    const draggable: DragTarget = { id, node: entry.node };
    const detect = props.collisionDetector ?? closestCenter;
    const origin = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let activated = false;
    let latest: DragEvent = { draggable, droppable: null };

    // Capture the pointer, so `pointerup` is delivered even when the release
    // happens outside the window. Without it a drag released off-screen never
    // ends: the row stays stuck to a button-up pointer and the user's next
    // click anywhere fires `onUp` with `activated` still true, committing a
    // reorder they never made. Guarded because a test DOM may not implement it.
    const captureTarget = event.currentTarget instanceof Element ? event.currentTarget : entry.node;
    captureTarget.setPointerCapture?.(pointerId);

    /** Ignore contacts other than the one that started this drag. Without this
     *  a second finger drives — or ends — the first finger's gesture. */
    const isOurs = (e: PointerEvent) => e.pointerId === pointerId;

    /**
     * The group's geometry, frozen at the moment the gesture began.
     *
     * Layout cannot change during a drag except for the transforms this package
     * writes, and those are exactly what must be excluded. Measuring live got
     * it wrong twice over: the stride was read from rects that already included
     * the dragged row's offset — drag row 0 down by one row height in a single
     * motion and the stride computed to ZERO, silently disabling shift-aside —
     * and the detector saw displaced rows in the slots they were moving to
     * rather than the ones they belonged to, so it chased its own output.
     *
     * It is also the difference between O(1) arithmetic and an
     * n-rect forced-layout sweep on every pointer event.
     */
    const measured = measure(entry.group);
    const stride = strideOf(measured);

    const reset = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      captureTarget.releasePointerCapture?.(pointerId);
      endGesture = null;
      setTransform(null);
      setDisplaced(new Map());
      setActive({ draggable: null, droppable: null });
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!isOurs(moveEvent)) return;
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;

      if (!activated) {
        if (Math.hypot(dx, dy) < ACTIVATION_DISTANCE) return;
        activated = true;
        setActive({ draggable, droppable: null });
        props.onDragStart?.({ draggable, droppable: null });
      }

      setTransform({ x: dx, y: dy });
      const droppable = detect(draggable, measured, {
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
      // Only a CHANGE of slot is worth reporting: the pointer emits a stream of
      // events inside one row, and a consumer ticking a haptic per event would
      // buzz continuously instead of once per row crossed.
      if (droppable?.id !== latest.droppable?.id) {
        latest = { draggable, droppable };
        setActive({ draggable, droppable });
        setDisplaced(computeDisplacement(measured, stride, id, droppable?.id ?? null));
        props.onDragOver?.(latest);
      }
    };

    const onUp = (upEvent: PointerEvent) => {
      if (!isOurs(upEvent)) return;
      reset();
      // A press that never crossed the threshold was a click, not a drag. Firing
      // `onDragEnd` here would commit a no-op move on every handle click.
      if (activated) props.onDragEnd?.(latest);
    };

    // Deliberately no `onDragEnd`: a cancelled gesture (the OS taking over, a
    // context menu) is not a drop, and committing one would move a row the user
    // never released.
    const onCancel = (cancelEvent: PointerEvent) => {
      if (!isOurs(cancelEvent)) return;
      reset();
    };

    endGesture = reset;
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
