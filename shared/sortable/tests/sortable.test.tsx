// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closestCenter,
  createSortable,
  DragDropProvider,
  DragDropSensors,
  maybeTransformStyle,
  SortableProvider,
  type DragEvent,
} from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * happy-dom does no layout — every `getBoundingClientRect()` is zeroes, so
 * `closestCenter` would see every row's centre at (0,0) and pick arbitrarily.
 * Stub stacked rects derived from each row's CURRENT DOM position, so they stay
 * correct after a reorder.
 */
function stubRowGeometry(height = 40) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const rows = [...document.querySelectorAll("[data-row]")];
    const index = rows.indexOf(this);
    const top = index === -1 ? 0 : index * height;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function Row(props: { id: string; label: string }) {
  const sortable = createSortable(props.id);
  return (
    <li data-row ref={sortable.ref} style={maybeTransformStyle(sortable.transform())}>
      <button {...sortable.dragActivators} data-grip={props.id}>
        grip {props.label}
      </button>
    </li>
  );
}

function List(props: { onDragEnd?: (e: DragEvent) => void; onDragOver?: (e: DragEvent) => void }) {
  const [ids] = createSignal(["a", "b", "c"]);
  return (
    <DragDropProvider
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      collisionDetector={closestCenter}
    >
      <DragDropSensors />
      <ul>
        <SortableProvider ids={ids()}>
          <For each={ids()}>{(id) => <Row id={id} label={id} />}</For>
        </SortableProvider>
      </ul>
    </DragDropProvider>
  );
}

/** Press, cross the activation threshold, travel, release. */
function drag(grip: Element, toY: number) {
  fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  // The first move exists to clear the sensor's distance threshold.
  fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 30 }));
  fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: toY }));
  fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: toY }));
}

describe("pointer dragging", () => {
  it("reports the row dragged and the row it landed on", () => {
    stubRowGeometry();
    const onDragEnd = vi.fn();
    render(() => <List onDragEnd={onDragEnd} />);
    drag(document.querySelector("[data-grip=a]")!, 100);
    expect(onDragEnd).toHaveBeenCalledOnce();
    const event = onDragEnd.mock.calls[0]![0] as DragEvent;
    expect(event.draggable.id).toBe("a");
    expect(event.droppable?.id).toBe("c");
  });

  it("leaves the order untouched when a press never moves", () => {
    // A handle is usually also a button. Without a distance threshold, every
    // click on it would start and immediately end a drag, committing a move.
    stubRowGeometry();
    const onDragEnd = vi.fn();
    render(() => <List onDragEnd={onDragEnd} />);
    const grip = document.querySelector("[data-grip=a]")!;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("does not activate on a movement below the threshold", () => {
    stubRowGeometry();
    const onDragEnd = vi.fn();
    render(() => <List onDragEnd={onDragEnd} />);
    const grip = document.querySelector("[data-grip=a]")!;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 11, clientY: 11 }));
    fireEvent(document, new PointerEvent("pointerup", { clientX: 11, clientY: 11 }));
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("ignores a non-primary button, so right-click keeps its context menu", () => {
    stubRowGeometry();
    const onDragEnd = vi.fn();
    render(() => <List onDragEnd={onDragEnd} />);
    const grip = document.querySelector("[data-grip=a]")!;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 90 }));
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 90 }));
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("reports each slot change once, not once per pointer event", () => {
    // A consumer ticks a haptic per `onDragOver`. Firing per event would buzz
    // continuously instead of once per row crossed.
    stubRowGeometry();
    const onDragOver = vi.fn();
    render(() => <List onDragOver={onDragOver} />);
    const grip = document.querySelector("[data-grip=a]")!;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 30 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 31 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 32 }));
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 32 }));
    const slots = onDragOver.mock.calls.map((c) => (c[0] as DragEvent).droppable?.id);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("does not commit a cancelled gesture", () => {
    // A cancelled drag (the OS taking over, a context menu) is not a drop, and
    // committing one would move a row the user never released.
    stubRowGeometry();
    const onDragEnd = vi.fn();
    render(() => <List onDragEnd={onDragEnd} />);
    const grip = document.querySelector("[data-grip=a]")!;
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 90 }));
    fireEvent(document, new PointerEvent("pointercancel", { clientX: 10, clientY: 90 }));
    expect(onDragEnd).not.toHaveBeenCalled();
  });
});

describe("the dragged row paints its offset", () => {
  it("writes a translate on the row while it is being dragged, and clears it after", () => {
    // The bug this pins is silent: `transform` is an accessor, so passing it
    // UNCALLED gives `maybeTransformStyle` a truthy function and paints
    // `translate3d(undefinedpx, undefinedpx, 0)` — the row simply never moves
    // under the pointer, with every drop-semantics test still green.
    stubRowGeometry();
    render(() => <List />);
    const grip = document.querySelector("[data-grip=a]")!;
    const row = grip.closest("[data-row]") as HTMLElement;

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 30 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 15, clientY: 50 }));
    expect(row.style.transform).toBe("translate3d(5px, 40px, 0)");

    fireEvent(document, new PointerEvent("pointerup", { clientX: 15, clientY: 50 }));
    expect(row.style.transform, "the offset outlived the drop").toBe("");
  });

  it("shifts the rows between the dragged one and its target, to open the gap", () => {
    // The drop preview. Without it only the row under the pointer moves and the
    // list gives no sign of where the row would land — which is how this
    // shipped at first: `transform` returned null for every non-dragged row, so
    // `EventsEditor`'s "animate the OTHER rows shifting aside" styling animated
    // nothing, and every drop-semantics test stayed green.
    stubRowGeometry();
    render(() => <List />);
    const grip = document.querySelector("[data-grip=a]")!;
    const rows = () => [...document.querySelectorAll("[data-row]")] as HTMLElement[];

    // Drag the first row down onto the third.
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 30 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 100 }));

    // Rows b and c come UP by one stride (40px, from the stubbed geometry) to
    // make room; the dragged row is on the pointer, not on a stride.
    expect(rows()[1]!.style.transform).toBe("translate3d(0px, -40px, 0)");
    expect(rows()[2]!.style.transform).toBe("translate3d(0px, -40px, 0)");
    expect(rows()[0]!.style.transform).toBe("translate3d(0px, 90px, 0)");

    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 100 }));
    for (const row of rows()) expect(row.style.transform).toBe("");
  });

  it("shifts the other way when dragging upwards", () => {
    stubRowGeometry();
    render(() => <List />);
    const grip = document.querySelector("[data-grip=c]")!;
    const rows = () => [...document.querySelectorAll("[data-row]")] as HTMLElement[];

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 90 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 70 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 10 }));

    // a and b go DOWN to open a slot at the top.
    expect(rows()[0]!.style.transform).toBe("translate3d(0px, 40px, 0)");
    expect(rows()[1]!.style.transform).toBe("translate3d(0px, 40px, 0)");
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));
  });

  it("leaves rows outside the moved range alone", () => {
    stubRowGeometry();
    render(() => <List />);
    const grip = document.querySelector("[data-grip=a]")!;
    const rows = () => [...document.querySelectorAll("[data-row]")] as HTMLElement[];

    // Drag row a only as far as row b — row c is not between them.
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 30 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 55 }));

    expect(rows()[1]!.style.transform).toBe("translate3d(0px, -40px, 0)");
    expect(rows()[2]!.style.transform, "an untouched row must write no transform").toBe("");
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 55 }));
  });
});

describe("maybeTransformStyle", () => {
  it("returns an empty map when there is no transform", () => {
    // NOT an identity transform: writing one would make every row a containing
    // block and a stacking context for its descendants, permanently.
    expect(maybeTransformStyle(null)).toEqual({});
  });

  it("returns a translate for a live transform", () => {
    expect(maybeTransformStyle({ x: 3, y: 7 })).toEqual({
      transform: "translate3d(3px, 7px, 0)",
    });
  });
});

describe("multi-container", () => {
  function TwoLists(props: { onDragEnd: (e: DragEvent) => void }) {
    return (
      <DragDropProvider onDragEnd={props.onDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <ul>
          <SortableProvider ids={["a1", "a2"]}>
            <Row id="a1" label="a1" />
            <Row id="a2" label="a2" />
          </SortableProvider>
        </ul>
        <ul>
          <SortableProvider ids={["b1", "b2"]}>
            <Row id="b1" label="b1" />
            <Row id="b2" label="b2" />
          </SortableProvider>
        </ul>
      </DragDropProvider>
    );
  }

  it("never lands an item from one list in another", () => {
    // Two lists on a page are two independent sortables. Dragging a task inside
    // "3 months out" must not drop it into "1 month out" — that would be a
    // re-bucketing, a semantic change, not a re-order.
    stubRowGeometry();
    const onDragEnd = vi.fn();
    render(() => <TwoLists onDragEnd={onDragEnd} />);
    // Drag the FIRST list's first row far enough to sit over the second list.
    drag(document.querySelector("[data-grip=a1]")!, 300);
    const event = onDragEnd.mock.calls[0]![0] as DragEvent;
    expect(event.draggable.id).toBe("a1");
    expect(["a2"]).toContain(event.droppable?.id);
  });
});
