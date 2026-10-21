// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, For, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closestCenter,
  createDraggable,
  createDroppable,
  createSortable,
  DragDropProvider,
  DragDropSensors,
  maybeTransformStyle,
  SortableProvider,
  type DragEvent,
} from "../src/index";

// Drop zones: a free item dragged onto one of several containers — a guest
// onto a table. One test per way the opt-in zone path can fail, beside the
// sortable lists that must not notice it exists.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
});

/**
 * happy-dom does no layout, so every measured element states its own box as
 * `data-rect="left top width height"` — in page coordinates, so the viewport
 * rect moves up as the window scrolls, the way a browser's does. A painted
 * `translate3d` moves it too.
 */
function stubGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const [left = 0, top = 0, width = 0, height = 0] = (this.getAttribute("data-rect") ?? "")
      .split(" ")
      .map(Number);
    const transform = (this as HTMLElement).style?.transform ?? "";
    const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(transform);
    const x = left + Number(match?.[1] ?? 0) - window.scrollX;
    const y = top + Number(match?.[2] ?? 0) - window.scrollY;
    return {
      top: y,
      bottom: y + height,
      left: x,
      right: x + width,
      width,
      height,
      x,
      y,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function Zone(props: { id: string; rect: string }) {
  const zone = createDroppable(props.id);
  return (
    <section
      data-zone={props.id}
      data-over={zone.isOver() ? "yes" : "no"}
      data-rect={props.rect}
      ref={zone.ref}
    />
  );
}

function Chip(props: { id: string; rect: string }) {
  const item = createDraggable(props.id);
  return (
    <span
      data-chip={props.id}
      data-rect={props.rect}
      ref={item.ref}
      style={maybeTransformStyle(item.transform())}
      {...item.dragActivators}
    />
  );
}

function Row(props: { id: string; top: number }) {
  const sortable = createSortable(props.id);
  return (
    <li
      data-row={props.id}
      data-rect={`0 ${props.top} 100 40`}
      ref={sortable.ref}
      style={maybeTransformStyle(sortable.transform())}
    >
      <button data-grip={props.id} {...sortable.dragActivators} />
    </li>
  );
}

/**
 * Two zones side by side at the top of the page (A at x 200–400, B at x
 * 450–650, y 0–200), a third far down the page (C at y 900–1100), a free chip
 * at the top left, and a three-row sortable list on the left whose first row's
 * id is the same as zone A's.
 */
function Board(props: {
  onDragEnd?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  showZoneA?: () => boolean;
}) {
  const [ids] = createSignal(["A", "r2", "r3"]);
  return (
    <DragDropProvider
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      collisionDetector={closestCenter}
    >
      <DragDropSensors />
      <Chip id="chip" rect="10 10 40 20" />
      <Show when={props.showZoneA?.() ?? true}>
        <Zone id="A" rect="200 0 200 200" />
      </Show>
      <Zone id="B" rect="450 0 200 200" />
      <Zone id="C" rect="200 900 200 200" />
      <ul>
        <SortableProvider ids={ids()}>
          <For each={ids()}>{(id, i) => <Row id={id} top={300 + i() * 40} />}</For>
        </SortableProvider>
      </ul>
    </DragDropProvider>
  );
}

const down = (el: Element, x: number, y: number) =>
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: y });
const move = (x: number, y: number) =>
  fireEvent(document, new PointerEvent("pointermove", { pointerId: 1, clientX: x, clientY: y }));
const up = (x: number, y: number) =>
  fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: y }));

/** Press the chip, clear the activation threshold, travel to (x, y). */
function pickUpChipAndMove(x: number, y: number) {
  down(document.querySelector("[data-chip=chip]")!, 20, 20);
  move(30, 30);
  move(x, y);
}

const overOf = (id: string) =>
  document.querySelector(`[data-zone=${id}]`)!.getAttribute("data-over");

describe("drop zones", () => {
  it("reports the zone a free item is dropped in", () => {
    stubGeometry();
    const onDragEnd = vi.fn();
    render(() => <Board onDragEnd={onDragEnd} />);
    pickUpChipAndMove(500, 100);
    up(500, 100);
    expect(onDragEnd).toHaveBeenCalledOnce();
    const event = onDragEnd.mock.calls[0]![0] as DragEvent;
    expect(event.draggable.id).toBe("chip");
    expect(event.droppable?.id).toBe("B");
  });

  it("reports no zone for a drop outside every zone", () => {
    stubGeometry();
    const onDragEnd = vi.fn();
    render(() => <Board onDragEnd={onDragEnd} />);
    // Between A and B: nearest to both, inside neither.
    pickUpChipAndMove(425, 100);
    up(425, 100);
    expect((onDragEnd.mock.calls[0]![0] as DragEvent).droppable).toBeNull();
  });

  it("never offers a sortable row to a free item, nor a zone to a sortable row", () => {
    stubGeometry();
    const onDragEnd = vi.fn();
    render(() => <Board onDragEnd={onDragEnd} />);
    // The chip released over row r3, which is no zone.
    pickUpChipAndMove(50, 390);
    up(50, 390);
    expect((onDragEnd.mock.calls[0]![0] as DragEvent).droppable).toBeNull();

    // Row r3 dragged into zone B's box: it lands on a row, never on the zone.
    down(document.querySelector("[data-grip=r3]")!, 50, 390);
    move(50, 380);
    move(500, 100);
    up(500, 100);
    const event = onDragEnd.mock.calls[1]![0] as DragEvent;
    expect(event.draggable.id).toBe("r3");
    expect(event.droppable?.node.hasAttribute("data-row")).toBe(true);
  });

  it("finds the zone under the pointer after the window scrolls mid-drag", () => {
    stubGeometry();
    const onDragEnd = vi.fn();
    render(() => <Board onDragEnd={onDragEnd} />);
    pickUpChipAndMove(300, 100);
    expect(overOf("A")).toBe("yes");
    // The page scrolls 850px under a still pointer: zone C is now under it.
    Object.defineProperty(window, "scrollY", { value: 850, configurable: true });
    fireEvent.scroll(window);
    expect(overOf("A")).toBe("no");
    expect(overOf("C")).toBe("yes");
    // The chip stays under the pointer: its offset carries the scroll.
    expect((document.querySelector("[data-chip=chip]") as HTMLElement).style.transform).toBe(
      "translate3d(280px, 930px, 0)",
    );
    up(300, 100);
    expect((onDragEnd.mock.calls[0]![0] as DragEvent).droppable?.id).toBe("C");
  });

  it("lights only the zone under the pointer, and nothing once the drag ends or is cancelled", () => {
    stubGeometry();
    render(() => <Board />);
    pickUpChipAndMove(300, 100);
    expect([overOf("A"), overOf("B"), overOf("C")]).toEqual(["yes", "no", "no"]);
    move(500, 100);
    expect([overOf("A"), overOf("B"), overOf("C")]).toEqual(["no", "yes", "no"]);
    up(500, 100);
    expect([overOf("A"), overOf("B"), overOf("C")]).toEqual(["no", "no", "no"]);

    pickUpChipAndMove(500, 100);
    expect(overOf("B")).toBe("yes");
    fireEvent(document, new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(overOf("B")).toBe("no");
  });

  it("moves the dragged item with the pointer and pushes no sortable row aside", () => {
    stubGeometry();
    render(() => <Board />);
    pickUpChipAndMove(50, 340);
    const chip = document.querySelector("[data-chip=chip]") as HTMLElement;
    expect(chip.style.transform).toBe("translate3d(30px, 320px, 0)");
    for (const id of ["A", "r2", "r3"]) {
      expect((document.querySelector(`[data-row=${id}]`) as HTMLElement).style.transform).toBe("");
    }
  });

  it("keeps a zone and a sortable row that share an id apart", () => {
    stubGeometry();
    const onDragEnd = vi.fn();
    const [showZoneA, setShowZoneA] = createSignal(true);
    render(() => <Board onDragEnd={onDragEnd} showZoneA={showZoneA} />);
    // Row "A" drags as a row while zone "A" exists…
    down(document.querySelector("[data-grip=A]")!, 50, 310);
    move(50, 330);
    move(50, 390);
    up(50, 390);
    expect((onDragEnd.mock.calls[0]![0] as DragEvent).droppable?.id).toBe("r3");
    // …a row drag lights no zone of the same id…
    down(document.querySelector("[data-grip=A]")!, 50, 310);
    move(50, 330);
    expect(overOf("A")).toBe("no");
    up(50, 330);
    // …and removing zone "A" leaves row "A" registered.
    setShowZoneA(false);
    down(document.querySelector("[data-grip=A]")!, 50, 310);
    move(50, 330);
    move(50, 390);
    up(50, 390);
    expect(onDragEnd).toHaveBeenCalledTimes(3);
    expect((onDragEnd.mock.calls[2]![0] as DragEvent).draggable.id).toBe("A");
  });

  it("keeps an item draggable after it moves to an earlier container and back", () => {
    stubGeometry();
    const onDragEnd = vi.fn();
    // The chip lives inside whichever zone holds it, so each move unmounts
    // its node from one zone and mounts a new one in the other. Zone A renders
    // before zone B, so moving into A mounts the new node before the old one's
    // cleanup runs.
    function Moving() {
      const [place, setPlace] = createSignal<"A" | "B">("B");
      const Holder = (props: { id: "A" | "B"; rect: string }) => {
        const zone = createDroppable(props.id);
        return (
          <section data-zone={props.id} data-rect={props.rect} ref={zone.ref}>
            <Show when={place() === props.id}>
              <Chip id="chip" rect={props.id === "A" ? "210 10 40 20" : "460 10 40 20"} />
            </Show>
          </section>
        );
      };
      return (
        <DragDropProvider
          onDragEnd={(event) => {
            onDragEnd(event);
            if (event.droppable) setPlace(event.droppable.id as "A" | "B");
          }}
        >
          <DragDropSensors />
          <Holder id="A" rect="200 0 200 200" />
          <Holder id="B" rect="450 0 200 200" />
        </DragDropProvider>
      );
    }
    render(() => <Moving />);
    const dragChipTo = (fromX: number, toX: number) => {
      down(document.querySelector("[data-chip=chip]")!, fromX, 20);
      move(fromX + 10, 30);
      move(toX, 100);
      up(toX, 100);
    };
    dragChipTo(470, 300); // B → A: the new node in A mounts first
    dragChipTo(220, 500); // A → B
    dragChipTo(470, 300); // and back again
    expect(onDragEnd).toHaveBeenCalledTimes(3);
    expect(onDragEnd.mock.calls.map((c) => (c[0] as DragEvent).droppable?.id)).toEqual([
      "A",
      "B",
      "A",
    ]);
  });
});
