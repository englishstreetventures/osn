// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, For, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSortableList } from "../src/list";

afterEach(() => cleanup());

function setup(initial = ["Ceremony", "Reception", "Brunch"]) {
  const [ids, setIds] = createSignal(initial);
  const onPhase = vi.fn();
  let list!: ReturnType<typeof createSortableList>;

  function Harness() {
    list = createSortableList({
      ids,
      labelFor: (id) => String(id),
      noun: "event",
      onMove: (from, to) => {
        const next = [...ids()];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        setIds(next);
      },
      onPhase,
    });
    return (
      <div>
        <p {...list.hintProps()}>{list.hintText}</p>
        <ul>
          <For each={ids()}>
            {(id, index) => {
              const item = list.item(id, index, () => ids().length);
              return (
                <li>
                  <button {...item.gripProps()} data-grip={id}>
                    grip
                  </button>
                  <button {...item.moveProps(-1)} data-up={id}>
                    {item.moveLabel(-1)}
                  </button>
                  <button {...item.moveProps(1)} data-down={id}>
                    {item.moveLabel(1)}
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={true}>
          <p {...list.liveRegionProps()}>{list.announcement()}</p>
        </Show>
      </div>
    );
  }

  render(() => <Harness />);
  return { ids, onPhase, list: () => list };
}

const grip = (id: string) => document.querySelector(`[data-grip="${id}"]`) as HTMLButtonElement;

describe("keyboard re-ordering", () => {
  it("moves a row down on ArrowDown", () => {
    const { ids } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    expect(ids()).toEqual(["Reception", "Ceremony", "Brunch"]);
  });

  it("moves a row up on ArrowUp", () => {
    const { ids } = setup();
    fireEvent.keyDown(grip("Brunch"), { key: "ArrowUp" });
    expect(ids()).toEqual(["Ceremony", "Brunch", "Reception"]);
  });

  it("does nothing at the ends of the list", () => {
    const { ids } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowUp" });
    fireEvent.keyDown(grip("Brunch"), { key: "ArrowDown" });
    expect(ids()).toEqual(["Ceremony", "Reception", "Brunch"]);
  });

  it("ignores keys that are not the arrows", () => {
    const { ids } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "Enter" });
    fireEvent.keyDown(grip("Ceremony"), { key: "j" });
    expect(ids()).toEqual(["Ceremony", "Reception", "Brunch"]);
  });

  it("ignores auto-repeat — one press, one move", () => {
    // Repeat fires ~30x/s and each move is a draft checkpoint plus a
    // revalidation, so a held key would stall the list and burn the undo stack.
    const { ids } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown", repeat: true });
    expect(ids()).toEqual(["Ceremony", "Reception", "Brunch"]);
  });

  it("claims the arrows even at a boundary, so the page never scrolls instead", () => {
    // `preventDefault` runs BEFORE the bounds check: a focused grip owns Up/Down
    // unconditionally rather than sometimes moving the row and sometimes
    // scrolling the page out from under it.
    setup();
    // `bubbles` because Solid delegates `onKeyDown` to the document root —
    // a non-bubbling event never reaches the handler at all.
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true, bubbles: true });
    grip("Ceremony").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("restores focus to the grip that moved", () => {
    // `<For>` moves the node rather than re-creating it, but a DOM move is a
    // remove-then-insert and focus does not survive it — without the explicit
    // restore, one keypress leaves focus on <body>.
    setup();
    grip("Ceremony").focus();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(grip("Ceremony"));
  });
});

describe("screen-reader move controls", () => {
  it("moves the row when activated", () => {
    // NVDA and JAWS browse mode eats bare arrows and never forwards them to a
    // button, so these are the only working path for those users.
    const { ids } = setup();
    (document.querySelector('[data-down="Ceremony"]') as HTMLButtonElement).click();
    expect(ids()).toEqual(["Reception", "Ceremony", "Brunch"]);
  });

  it("is disabled at the list ends, so AT reports the boundary", () => {
    setup();
    expect((document.querySelector('[data-up="Ceremony"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((document.querySelector('[data-down="Brunch"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((document.querySelector('[data-down="Ceremony"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("names the row it moves", () => {
    setup();
    expect(document.querySelector('[data-up="Reception"]')?.textContent).toBe("Move Reception up");
  });
});

describe("announcements", () => {
  it("announces a completed move with its new position", () => {
    const { list } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    expect(list().announcement()).toBe("Ceremony moved to position 2 of 3.");
  });

  it("re-announces an identical consecutive move", () => {
    // A live region only speaks when its text CHANGES, and walking one row down
    // the list repeatedly produces the same sentence every time. The clear-then-
    // set is what keeps the second press from being silent — this asserts the
    // empty write really happened.
    const { list } = setup(["A", "B", "C", "D"]);
    const seen: string[] = [];
    // Re-read after every set by subscribing through the accessor.
    fireEvent.keyDown(grip("A"), { key: "ArrowDown" });
    seen.push(list().announcement());
    fireEvent.keyDown(grip("A"), { key: "ArrowDown" });
    seen.push(list().announcement());
    expect(seen[0]).toBe("A moved to position 2 of 4.");
    expect(seen[1]).toBe("A moved to position 3 of 4.");
  });

  it("clears rather than re-announcing, for an undo", () => {
    // An undo may have reverted a field edit rather than a re-order, and
    // guessing which would be worse than silence.
    const { list } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    expect(list().announcement()).not.toBe("");
    list().clearAnnouncement();
    expect(list().announcement()).toBe("");
  });

  it("carries the live position in each grip's label", () => {
    setup();
    expect(grip("Reception").getAttribute("aria-label")).toBe("Reorder Reception, position 2 of 3");
    fireEvent.keyDown(grip("Reception"), { key: "ArrowUp" });
    expect(grip("Reception").getAttribute("aria-label")).toBe("Reorder Reception, position 1 of 3");
  });

  it("points every grip at the shared instructions", () => {
    const { list } = setup();
    expect(grip("Ceremony").getAttribute("aria-describedby")).toBe(list().hintId);
    expect(document.getElementById(list().hintId)?.textContent).toContain("arrow keys");
  });

  it("generates a distinct hint id per list, so several can share a page", () => {
    // `id="reorder-hint"` was hardcoded when only one list had dragging. Two
    // lists would then both claim it and every grip on the page would describe
    // itself with whichever won.
    const a = setup();
    const b = setup();
    expect(a.list().hintId).not.toBe(b.list().hintId);
  });
});

describe("phase callbacks", () => {
  it("confirms a keyboard move", () => {
    const { onPhase } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    expect(onPhase).toHaveBeenCalledWith("commit");
  });

  it("does not confirm a move that was refused at a boundary", () => {
    const { onPhase } = setup();
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowUp" });
    expect(onPhase).not.toHaveBeenCalled();
  });
});
