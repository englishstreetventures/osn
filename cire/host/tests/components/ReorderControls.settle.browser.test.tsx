import {
  closestCenter,
  createSortable,
  createSortableList,
  DragDropProvider,
  maybeTransformStyle,
  SortableProvider,
} from "@shared/sortable";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import ReorderControls from "../../src/components/ReorderControls";

import "../../src/styles/global.css";

/**
 * A row dropped with a real pointer eases from where it was let go into its
 * slot (`@shared/sortable`'s settle). The list is a flex column, as every
 * portal list is, of `relative` rows with `ReorderControls` at their start, as
 * the budget's are. Only an engine runs the transition, lays out the slot and
 * paints one row over another, so the settle is held here.
 *
 * Every duration runs ten times slower (`--motion-scale`), so a slow runner
 * still finds the settle running when it looks; the assertions read the
 * transition's own timing, and pause it where they measure.
 *
 * Artifact: `cire/host/.vitest/attachments/sortable-settle/` — the first frame
 * of a settle at desktop width in the dark ramp and at phone width in the
 * light one. Same rows, same drag, every run.
 */

const ARTIFACTS = "../../.vitest/attachments/sortable-settle";
const MOTION_SCALE = "10";

const LABELS: Record<string, string> = {
  a: "Ceremony",
  b: "Drinks",
  c: "Dinner",
  d: "Dancing",
};

function List() {
  const [ids, setIds] = createSignal(["a", "b", "c", "d"]);
  const list = createSortableList({
    ids,
    labelFor: (id) => LABELS[String(id)]!,
    noun: "event",
    onMove: (from, to) => {
      const next = [...ids()];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      setIds(next);
    },
  });
  return (
    <DragDropProvider {...list.dragHandlers} collisionDetector={closestCenter}>
      <ul class="flex w-80 flex-col gap-1 p-4">
        <SortableProvider ids={ids()}>
          <For each={ids()}>
            {(id, i) => {
              const sortable = createSortable(id);
              return (
                <li
                  ref={sortable.ref}
                  data-row={id}
                  style={maybeTransformStyle(sortable.transform())}
                  class="border-border bg-surface relative flex h-12 items-center gap-2 rounded-sm border px-2"
                  classList={{ "z-10 shadow-(--elev-2)": sortable.isActiveDraggable() }}
                >
                  <ReorderControls
                    sortable={sortable}
                    item={list.item(id, i, () => ids().length)}
                  />
                  <span class="text-text grow">{LABELS[id]}</span>
                </li>
              );
            }}
          </For>
        </SortableProvider>
      </ul>
    </DragDropProvider>
  );
}

const row = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;
const grip = (id: string) =>
  row(id).querySelector('button[aria-label^="Reorder "]') as HTMLButtonElement;
const order = () =>
  [...document.querySelectorAll("[data-row]")].map((el) => el.getAttribute("data-row"));

const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};

async function mouse(
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  at: { x: number; y: number },
) {
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

/** The transform transition running on `el`, if one is. */
const settling = (el: HTMLElement) =>
  el
    .getAnimations()
    .find((a) => a instanceof CSSTransition && a.transitionProperty === "transform");

/** Where `el` is painted, against where it would be with no transform. */
const shown = (el: HTMLElement) => {
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: m.m41, y: m.m42 };
};

/** What `transition` with these tokens computes to here, read off a probe. */
function computedTiming(duration: string, easing: string) {
  const probe = document.createElement("div");
  probe.style.transition = `transform var(${duration}) var(${easing})`;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const out = { duration: style.transitionDuration, easing: style.transitionTimingFunction };
  probe.remove();
  return out;
}

/**
 * Press Drinks' grip and drag it up, drifting right, until the pointer is
 * nearer Ceremony than any other row; return Drinks' box at that moment, which
 * is where it is let go.
 */
async function dragDrinksUp() {
  const from = centre(grip("b"));
  await mouse("mouseMoved", from);
  await mouse("mousePressed", from);
  await mouse("mouseMoved", { x: from.x + 10, y: from.y - 10 });
  await mouse("mouseMoved", { x: from.x + 24, y: from.y - 30 });
  return { at: { x: from.x + 24, y: from.y - 30 }, box: row("b").getBoundingClientRect() };
}

beforeEach(() => {
  document.documentElement.style.setProperty("--motion-scale", MOTION_SCALE);
});

afterEach(async () => {
  cleanup();
  document.documentElement.style.removeProperty("--motion-scale");
  await commands.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
});

describe("a dropped row settles into its slot", () => {
  it.each([
    { name: "desktop-dark", width: 1280, height: 900, scheme: "dark" as const },
    { name: "phone-light", width: 390, height: 844, scheme: "light" as const },
  ])(
    "starts the settle at the release offset and ends at none ($name)",
    async ({ name, width, height, scheme }) => {
      await page.viewport(width, height);
      await commands.emulateMedia({ colorScheme: scheme });
      render(() => <List />);

      const { at, box: released } = await dragDrinksUp();
      await mouse("mouseReleased", at);

      expect(order()).toEqual(["b", "a", "c", "d"]);
      const run = settling(row("b"));
      expect(run, "the row jumped into its slot").toBeDefined();
      run!.pause();
      run!.currentTime = 0;

      // On the app's own rung and curve: `--dur-base` follows the desk ladder.
      const tokens = computedTiming("--dur-base", "--ease-out");
      expect(getComputedStyle(row("b")).transitionDuration).toBe(tokens.duration);
      expect(getComputedStyle(row("b")).transitionTimingFunction).toBe(tokens.easing);

      // The first frame is where the row was let go, drift and all.
      const first = shown(row("b"));
      expect(Math.abs(first.x)).toBeGreaterThan(4);
      expect(Math.abs(first.y)).toBeGreaterThan(4);

      // It lands over Ceremony, which now sits below it and is positioned:
      // the overlap shows Drinks, not Ceremony painted over it.
      const ceremony = row("a").getBoundingClientRect();
      const overlap = {
        x: ceremony.left + ceremony.width / 2,
        y: (ceremony.top + released.bottom) / 2,
      };
      expect(released.bottom).toBeGreaterThan(ceremony.top);
      expect(row("b").contains(document.elementFromPoint(overlap.x, overlap.y))).toBe(true);
      await page.screenshot({ path: `${ARTIFACTS}/first-frame-${name}.png` });

      run!.finish();
      await run!.finished;
      const slot = row("b").getBoundingClientRect();
      expect(first.x).toBeCloseTo(released.left - slot.left, 0);
      expect(first.y).toBeCloseTo(released.top - slot.top, 0);
      expect(getComputedStyle(row("b")).transform).toBe("none");
      expect(row("b").style.transform).toBe("");
      expect(row("b").style.transition).toBe("");
      expect(row("b").style.zIndex).toBe("");
    },
  );

  it("lands at once under reduced motion", async () => {
    await page.viewport(1280, 900);
    await commands.emulateMedia({ reducedMotion: "reduce" });
    render(() => <List />);

    const { at } = await dragDrinksUp();
    await mouse("mouseReleased", at);

    expect(order()).toEqual(["b", "a", "c", "d"]);
    expect(settling(row("b"))).toBeUndefined();
    expect(row("b").style.transform).toBe("");
    expect(getComputedStyle(row("b")).transform).toBe("none");
  });

  it("is caught mid-settle by a new drag without a jump", async () => {
    await page.viewport(1280, 900);
    render(() => <List />);

    const { at } = await dragDrinksUp();
    await mouse("mouseReleased", at);
    const run = settling(row("b"))!;
    run.pause();
    run.currentTime = Number(run.effect!.getComputedTiming().duration) / 10;
    const seen = row("b").getBoundingClientRect();
    const slot = { top: seen.top - shown(row("b")).y, left: seen.left - shown(row("b")).x };
    expect(Math.abs(seen.top - slot.top), "caught too late to show a jump").toBeGreaterThan(4);

    // Pressed where it is seen: it stays there.
    const press = centre(grip("b"));
    await mouse("mouseMoved", press);
    await mouse("mousePressed", press);
    expect(settling(row("b"))).toBeUndefined();
    let box = row("b").getBoundingClientRect();
    expect(box.top).toBeCloseTo(seen.top, 0);
    expect(box.left).toBeCloseTo(seen.left, 0);

    // Picked up: it moves with the pointer from there.
    await mouse("mouseMoved", { x: press.x, y: press.y + 10 });
    box = row("b").getBoundingClientRect();
    expect(box.top).toBeCloseTo(seen.top + 10, 0);
    expect(box.left).toBeCloseTo(seen.left, 0);

    // Dropped: the nearest row is Ceremony again, and it settles once more.
    await mouse("mouseReleased", { x: press.x, y: press.y + 10 });
    expect(order()).toEqual(["a", "b", "c", "d"]);
    const again = settling(row("b"));
    expect(again).toBeDefined();
    again!.finish();
    await again!.finished;
    expect(getComputedStyle(row("b")).transform).toBe("none");
    expect(row("b").style.transition).toBe("");
  });

  it("eases a cancelled drag back to the slot it left", async () => {
    await page.viewport(1280, 900);
    render(() => <List />);
    let pointerId = -1;
    document.addEventListener("pointerdown", (e) => (pointerId = e.pointerId), { once: true });

    const { at, box: released } = await dragDrinksUp();
    document.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));

    expect(order(), "a cancel is not a drop").toEqual(["a", "b", "c", "d"]);
    const run = settling(row("b"));
    expect(run, "the row jumped back").toBeDefined();
    run!.pause();
    run!.currentTime = 0;
    const first = shown(row("b"));
    run!.finish();
    await run!.finished;
    const slot = row("b").getBoundingClientRect();
    expect(first.x).toBeCloseTo(released.left - slot.left, 0);
    expect(first.y).toBeCloseTo(released.top - slot.top, 0);
    expect(getComputedStyle(row("b")).transform).toBe("none");
    await mouse("mouseReleased", at);
  });

  it("writes no transform for a keyboard move", async () => {
    await page.viewport(1280, 900);
    render(() => <List />);

    grip("b").focus();
    await userEvent.keyboard("{ArrowUp}");

    expect(order()).toEqual(["b", "a", "c", "d"]);
    expect(row("b").style.transform).toBe("");
    expect(row("b").getAnimations()).toHaveLength(0);
  });
});
