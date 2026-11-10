import {
  createContext,
  createMemo,
  createSelector,
  createSignal,
  onCleanup,
  type Accessor,
  type ParentProps,
  useContext,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import { closestCenter, pointerWithin } from "./collision";
import type { DragEvent, DragTarget, Id, MeasuredTarget, Transform } from "./types";

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Not decoration: without it a plain click on the handle starts and ends a
 * drag, and any list where the handle is also a button loses the button. The
 * events list's tests press without moving and assert the order is untouched.
 */
export const ACTIVATION_DISTANCE = 4;

/**
 * The group every free item (`createDraggable`) registers under. A drag that
 * starts on one measures the drop zones instead of a list: see `startDrag`.
 */
export const FREE_GROUP: unique symbol = Symbol("free-draggables");

/**
 * How a dropped row eases into its slot: the app's `--dur-base` and
 * `--ease-out` where it has them (cire's ladder, which shortens at a desk),
 * the shared contract's otherwise.
 */
const SETTLE_TRANSITION =
  "transform var(--dur-base, var(--ui-dur-base)) var(--ease-out, var(--ui-ease-out))";

const translate = (t: Transform) => `translate3d(${t.x}px, ${t.y}px, 0)`;

const reducedMotion = () =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type Detector = (
  draggable: DragTarget,
  droppables: MeasuredTarget[],
  pointer: { x: number; y: number },
) => DragTarget | null;

interface DragState {
  active: Accessor<{ draggable: DragTarget | null; droppable: DragTarget | null }>;
  /**
   * Whether a drag is live. A row that styles itself by this should read it
   * rather than `active()`: `active` changes on every slot the pointer crosses,
   * this only when a drag starts or ends, so a long list re-runs each row's
   * effect twice per gesture instead of once per slot.
   */
  dragging: Accessor<boolean>;
  /** Whether `id` is the row being dragged. Notifies only the rows whose answer flips. */
  isDragged: (id: Id) => boolean;
  /**
   * Whether `id` is a dropped row still easing into its slot, or one a new
   * press has caught mid-settle and holds where it was. Notifies only the rows
   * whose answer flips.
   */
  isSettling: (id: Id) => boolean;
  /** The dragged row's offset from where it started. `null` when nothing is dragging. */
  transform: Accessor<Transform | null>;
  /** How far a NON-dragged row has been pushed to open the gap. 0 for most rows. */
  displacement: (id: Id) => number;
  /** Whether a free item is being dragged over the drop zone `id`. Notifies
   *  only the zones whose answer flips. Never true during a list's re-order. */
  isOver: (id: Id) => boolean;
}

interface Registry {
  register: (id: Id, node: HTMLElement, group: symbol) => void;
  /** Forgets `id` only while `node` is still the one registered for it. An
   *  item that moves between containers mounts its new node before the old one
   *  is cleaned up when the new container renders first; unregistering by id
   *  alone would then drop the live node, and the item would stop dragging. */
  unregister: (id: Id, node: HTMLElement | undefined) => void;
  registerGroup: (group: symbol, ids: Accessor<Id[]>) => void;
  unregisterGroup: (group: symbol) => void;
  /** Drop zones live in a map of their own, so a zone and an item may share
   *  an id — a table that is both a row of one list and a place to drop. */
  registerZone: (id: Id, node: HTMLElement) => void;
  /** As `unregister`: forgets the zone only while `node` is still its node. */
  unregisterZone: (id: Id, node: HTMLElement | undefined) => void;
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
 *
 * ## Drop zones
 *
 * Moving an item BETWEEN containers is the other gesture: a guest dragged onto
 * a table. That item is a free item (`createDraggable`), the containers are
 * zones (`createDroppable`), and its drag measures the zones instead of a list.
 * Lists under the same provider are untouched by it, and it by them.
 */
export function DragDropProvider(props: ParentProps<DragDropProviderProps>) {
  const items = new Map<Id, { node: HTMLElement; group: symbol }>();
  /** A group's declared order, from its `SortableProvider`'s `ids`. */
  const groups = new Map<symbol, Accessor<Id[]>>();
  const zones = new Map<Id, HTMLElement>();

  const [active, setActive] = createSignal<{
    draggable: DragTarget | null;
    droppable: DragTarget | null;
  }>({ draggable: null, droppable: null });
  const draggedId = createMemo(() => active().draggable?.id ?? null);
  const dragging = createMemo(() => draggedId() !== null);
  const isDragged = createSelector<Id | null, Id>(draggedId);
  const [transform, setTransform] = createSignal<Transform | null>(null);
  const [overZone, setOverZone] = createSignal<Id | null>(null);
  const isOver = createSelector<Id | null, Id>(overZone);
  // A store rather than a Map signal: reading `displaced[key]` tracks that one
  // key, so a slot change wakes only the rows whose shift changed, not every row.
  const [displaced, setDisplaced] = createStore<Record<string, number>>({});

  const register = (id: Id, node: HTMLElement, group: symbol) => items.set(id, { node, group });
  const unregister = (id: Id, node: HTMLElement | undefined) => {
    if (items.get(id)?.node === node) items.delete(id);
  };
  const registerGroup = (group: symbol, ids: Accessor<Id[]>) => groups.set(group, ids);
  const unregisterGroup = (group: symbol) => groups.delete(group);
  const registerZone = (id: Id, node: HTMLElement) => zones.set(id, node);
  const unregisterZone = (id: Id, node: HTMLElement | undefined) => {
    if (zones.get(id) === node) zones.delete(id);
  };

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

  /** Every drop zone, measured once, as `measure` does a list. */
  function measureZones(): MeasuredTarget[] {
    const out: MeasuredTarget[] = [];
    for (const [id, node] of zones) out.push({ id, node, rect: node.getBoundingClientRect() });
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

  const displacement = (id: Id) => displaced[String(id)] ?? 0;

  /** Tears down whatever gesture is live. Set by `startDrag`, cleared by it. */
  let endGesture: (() => void) | null = null;

  // A gesture that is still live when the provider unmounts would otherwise
  // leave three document listeners behind, firing into a disposed scope — and
  // the next `pointerup` anywhere would call the consumer's `onDragEnd` with
  // stale indices, committing a reorder nobody made.
  onCleanup(() => endGesture?.());

  /** The row easing into its slot after a drop, if one is. */
  let settling: { node: HTMLElement } | null = null;
  /**
   * The id `isSettling` answers for: set at the release, before the drag's
   * state is cleared, and cleared when the row lands, so a row styled by
   * `isDragged || isSettling` keeps one look from pick-up to landing, and the
   * stacking that look carries holds it above the neighbours it crosses. A row
   * caught mid-settle keeps it while it is held.
   */
  const [settlingId, setSettlingId] = createSignal<Id | null>(null);
  const isSettling = createSelector<Id | null, Id>(settlingId);

  /**
   * Ease a let-go row from where it was released into the slot it has now.
   *
   * `from` is its box at release. The offset to its slot is written inline with
   * no transition, a style read commits it as the starting point, and the
   * transform is then let go on `SETTLE_TRANSITION`. The inline transition comes
   * off, and `isSettling` turns false, when that transition ends or is
   * cancelled. Under reduced motion, or with nothing to cover, the row is simply
   * in its slot.
   */
  function settle(node: HTMLElement, from: DOMRect) {
    node.style.transition = "none";
    node.style.transform = "";
    const slot = node.getBoundingClientRect();
    const offset = { x: from.left - slot.left, y: from.top - slot.top };
    if ((offset.x === 0 && offset.y === 0) || reducedMotion()) {
      node.style.transition = "";
      setSettlingId(null);
      return;
    }
    node.style.transform = translate(offset);
    void getComputedStyle(node).transform;
    node.style.transition = SETTLE_TRANSITION;
    node.style.transform = "";

    const record = { node };
    settling = record;
    const landed = () => {
      if (settling !== record) return;
      settling = null;
      setSettlingId(null);
      node.style.transition = "";
    };
    const run = node
      .getAnimations?.()
      .find((a) => "transitionProperty" in a && a.transitionProperty === "transform");
    // `finished` resolves at the end and rejects on a cancel; either way it has
    // landed. No transition started (the tokens are missing, say): it already has.
    if (run) run.finished.then(landed, landed);
    else landed();
  }

  /**
   * End any settle at once, before a new drag measures the list: the snapshot
   * must not see a settling row's offset. The row is left in its slot with no
   * inline transform. When it is `node`, the row being picked up, its offset
   * from that slot at the moment it was caught is returned, with its inline
   * transition still `none`, so the drag can carry on from there rather than
   * jump; it stays `isSettling` through the gesture that caught it.
   */
  function stopSettle(node: HTMLElement): Transform | null {
    const live = settling;
    if (!live) return null;
    settling = null;
    const seen = live.node === node ? node.getBoundingClientRect() : null;
    live.node.style.transition = "none";
    live.node.style.transform = "";
    const slot = live.node.getBoundingClientRect();
    if (!seen) {
      live.node.style.transition = "";
      setSettlingId(null);
      return null;
    }
    return { x: seen.left - slot.left, y: seen.top - slot.top };
  }

  function startDrag(id: Id, event: PointerEvent) {
    const entry = items.get(id);
    if (!entry) return;

    const draggable: DragTarget = { id, node: entry.node };
    // A free item is dropped INTO a zone rather than BETWEEN rows: it measures
    // the zones, finds the one the pointer is inside, and shifts nothing aside.
    const free = entry.group === FREE_GROUP;
    const detect = free ? pointerWithin : (props.collisionDetector ?? closestCenter);
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

    // Before the snapshot below, which must see every row in its slot.
    const caught = stopSettle(entry.node);

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
    const measured = free ? measureZones() : measure(entry.group);
    const stride = free ? 0 : strideOf(measured);
    // A row caught mid-settle stays where it was caught until the drag moves it.
    const carry = caught ?? { x: 0, y: 0 };
    if (caught) entry.node.style.transform = translate(caught);

    /**
     * How far the window has scrolled since the drag began — for a free item
     * only. Zones are spread over a page, so reaching one can take a scroll
     * mid-drag (a wheel, or the keyboard). The geometry stays the snapshot from
     * the start, so the pointer is carried back into that snapshot's
     * coordinates rather than the zones re-measured, and the item's own offset
     * carries the scroll so it stays under the pointer. A scroller other than
     * the window is not followed: a zone inside one is measured where it was.
     */
    const scrollOrigin = { x: window.scrollX, y: window.scrollY };
    const scrolled = () =>
      free
        ? { x: window.scrollX - scrollOrigin.x, y: window.scrollY - scrollOrigin.y }
        : { x: 0, y: 0 };
    let pointer = origin;

    const reset = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("scroll", onScroll);
      captureTarget.releasePointerCapture?.(pointerId);
      endGesture = null;
      setTransform(null);
      setDisplaced(reconcile({}));
      setOverZone(null);
      setActive({ draggable: null, droppable: null });
    };

    /** Place the dragged item and find what it is over, for the pointer at
     *  `pointer` and the window where it is now. */
    const track = () => {
      const scroll = scrolled();
      setTransform({
        x: pointer.x - origin.x + scroll.x + carry.x,
        y: pointer.y - origin.y + scroll.y + carry.y,
      });
      const droppable = detect(draggable, measured, {
        x: pointer.x + scroll.x,
        y: pointer.y + scroll.y,
      });
      // Only a CHANGE of slot is worth reporting: the pointer emits a stream of
      // events inside one row, and a consumer ticking a haptic per event would
      // buzz continuously instead of once per row crossed.
      if (droppable?.id !== latest.droppable?.id) {
        latest = { draggable, droppable };
        setActive({ draggable, droppable });
        if (free) {
          setOverZone(droppable?.id ?? null);
        } else {
          setDisplaced(
            reconcile(
              Object.fromEntries(computeDisplacement(measured, stride, id, droppable?.id ?? null)),
            ),
          );
        }
        props.onDragOver?.(latest);
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!isOurs(moveEvent)) return;
      pointer = { x: moveEvent.clientX, y: moveEvent.clientY };

      if (!activated) {
        if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < ACTIVATION_DISTANCE) return;
        activated = true;
        setActive({ draggable, droppable: null });
        props.onDragStart?.({ draggable, droppable: null });
      }
      track();
    };

    /** A scroll under a still pointer moves what is under it. */
    const onScroll = () => {
      if (activated) track();
    };

    /**
     * A list row's box as it is let go, when it is off its slot: after a drag,
     * or a press on a row caught mid-settle. The row is marked settling here,
     * before `reset` clears the drag, so its lifted look runs on unbroken. A
     * free item does not settle: it leaves for another container.
     */
    const released = () => {
      if (free || !(activated || caught)) return null;
      setSettlingId(id);
      return entry.node.getBoundingClientRect();
    };

    /** Ease the row from `from` into the slot it has now, on whichever node
     *  is registered for it after the drop. */
    const land = (from: DOMRect | null) => {
      if (!from) return;
      const node = items.get(id)?.node;
      if (node?.isConnected) settle(node, from);
      else setSettlingId(null);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (!isOurs(upEvent)) return;
      const from = released();
      reset();
      try {
        // A press that never crossed the threshold was a click, not a drag. Firing
        // `onDragEnd` here would commit a no-op move on every handle click.
        if (activated) props.onDragEnd?.(latest);
      } finally {
        land(from);
      }
    };

    // Deliberately no `onDragEnd`: a cancelled gesture (the OS taking over, a
    // context menu) is not a drop, and committing one would move a row the user
    // never released. The row eases back to the slot it left.
    const onCancel = (cancelEvent: PointerEvent) => {
      if (!isOurs(cancelEvent)) return;
      const from = released();
      reset();
      land(from);
    };

    endGesture = reset;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    if (free) window.addEventListener("scroll", onScroll, { passive: true });
  }

  return (
    <DragDropContext.Provider
      value={[
        { active, dragging, isDragged, isSettling, transform, displacement, isOver },
        {
          register,
          unregister,
          registerGroup,
          unregisterGroup,
          registerZone,
          unregisterZone,
          startDrag,
        },
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
