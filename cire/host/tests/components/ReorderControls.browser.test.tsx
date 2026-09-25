import {
  closestCenter,
  createSortable,
  createSortableList,
  DragDropProvider,
  SortableProvider,
} from "@shared/sortable";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import ReorderControls from "../../src/components/ReorderControls";

import "../../src/styles/global.css";

/**
 * The grip the gift list, the checklist and the budget all draw is their only
 * pointer affordance for re-ordering, on a portal used on phones, so WCAG 2.2
 * SC 2.5.8 (Target Size, Minimum) puts a 24x24 CSS-pixel floor under it. Only an
 * engine can measure that, so this mounts `ReorderControls` itself — not a copy
 * of its button — inside the narrowest row shape the three lists use: a flex row
 * with a greedy sibling. `MINIMUM_TARGET` is SC 2.5.8's floor, in CSS pixels.
 */
const MINIMUM_TARGET = 24;

function Row() {
  const list = createSortableList({
    ids: () => ["a"],
    labelFor: () => "Copper pan",
    noun: "gift",
    onMove: () => {},
  });
  return (
    <DragDropProvider {...list.dragHandlers} collisionDetector={closestCenter}>
      <SortableProvider ids={["a"]}>
        {(() => {
          const sortable = createSortable("a");
          return (
            <div class="flex w-24 items-center" ref={sortable.ref}>
              <ReorderControls
                sortable={sortable}
                item={list.item(
                  "a",
                  () => 0,
                  () => 1,
                )}
              />
              <span class="grow">A gift title long enough to want every pixel in the row</span>
            </div>
          );
        })()}
      </SortableProvider>
    </DragDropProvider>
  );
}

describe("reorder grip — painted", () => {
  afterEach(() => cleanup());

  it("meets the 24px minimum target in both axes beside a greedy sibling", () => {
    const result = render(() => <Row />);
    const grip = result.container.querySelector(
      'button[aria-label^="Reorder "]',
    ) as HTMLButtonElement;
    const box = grip.getBoundingClientRect();

    expect(box.width).toBeGreaterThanOrEqual(MINIMUM_TARGET);
    expect(box.height).toBeGreaterThanOrEqual(MINIMUM_TARGET);
  });
});
