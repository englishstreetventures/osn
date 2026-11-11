import {
  closestCenter,
  createSortable,
  createSortableList,
  DragDropProvider,
  maybeTransformStyle,
  SortableProvider,
} from "@shared/sortable";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, For, type JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A row dropped with a real pointer eases from where it was let go into its
 * slot (`@shared/sortable`'s settle). Only an engine runs the transition, lays
 * out the slot and paints one row over another, so the settle is held here.
 *
 * Most cases drag a stand-in list: a flex column, as every portal list is, of
 * `relative` rows with `ReorderControls` at their start and the budget row's
 * own fills at rest and lifted. The last case drags the real `BudgetView`, for
 * the one thing the stand-in cannot hold: that a portal list puts the row in
 * its new slot before `onDragEnd` returns.
 *
 * Every duration runs ten times slower (`--motion-scale`), so a slow runner
 * still finds the settle running when it looks; the assertions read the
 * transition's own timing, and pause it where they measure. A case that must
 * read what the release left before any frame runs ends the gesture with a
 * `pointerup` or `pointercancel` of its own, in the same task as the read.
 *
 * Artifact: `cire/host/.vitest/attachments/sortable-settle/` — the first frame
 * of a settle at desktop width in the dark ramp and at phone width in the
 * light one, and the budget's at desktop width in the light ramp. Same rows,
 * same drag, every run.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import BudgetView from "../../src/components/BudgetView";
import ReorderControls from "../../src/components/ReorderControls";
import { __resetBudgetCache, setCachedBudget } from "../../src/lib/budget-store";

const ARTIFACTS = "../../.vitest/attachments/sortable-settle";
const MOTION_SCALE = "10";

const LABELS: Record<string, string> = {
  a: "Ceremony",
  b: "Drinks",
  c: "Dinner",
  d: "Dancing",
};

/** `style` puts custom properties on a box around the list, for the token cases. */
function List(props: { style?: JSX.CSSProperties }) {
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
    <div data-box style={props.style}>
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
                    class="border-border bg-surface/10 relative flex h-12 items-center gap-2 rounded-sm border px-2"
                    classList={{
                      "border-gold/60 bg-surface/80 z-10 shadow-(--elev-2)":
                        sortable.isActiveDraggable(),
                    }}
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
    </div>
  );
}

const row = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;
const gripIn = (el: Element) =>
  el.querySelector('button[aria-label^="Reorder "]') as HTMLButtonElement;
const grip = (id: string) => gripIn(row(id));
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

/** The id of the next press's pointer, so a test can end its gesture itself. */
function nextPointer() {
  const pointer = { id: -1 };
  document.addEventListener("pointerdown", (e) => (pointer.id = e.pointerId), { once: true });
  return pointer;
}

/** End the gesture in this task, so what the handler left is read before any frame runs. */
const end = (type: "pointerup" | "pointercancel", pointer: { id: number }) =>
  document.dispatchEvent(new PointerEvent(type, { pointerId: pointer.id, bubbles: true }));

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

/** The row's look as the engine paints it: lifted or at rest. */
const look = (el: HTMLElement) => {
  const style = getComputedStyle(el);
  return { shadow: style.boxShadow, fill: style.backgroundColor, edge: style.borderTopColor };
};

/** What `transition` with these tokens computes to inside `within`, read off a probe. */
function computedTiming(duration: string, easing: string, within: Element = document.body) {
  const probe = document.createElement("div");
  probe.style.transition = `transform var(${duration}) var(${easing})`;
  within.append(probe);
  const style = getComputedStyle(probe);
  const out = { duration: style.transitionDuration, easing: style.transitionTimingFunction };
  probe.remove();
  return out;
}

/**
 * Press `handle` and drag it up, drifting right, until the pointer is nearer
 * the row above than any other; return where the pointer is and the dragged
 * row's box at that moment, which is where it is let go.
 */
async function dragUp(handle: Element) {
  const from = centre(handle);
  await mouse("mouseMoved", from);
  await mouse("mousePressed", from);
  await mouse("mouseMoved", { x: from.x + 10, y: from.y - 10 });
  await mouse("mouseMoved", { x: from.x + 24, y: from.y - 30 });
  const dragged = handle.closest("li")!;
  return { at: { x: from.x + 24, y: from.y - 30 }, box: dragged.getBoundingClientRect() };
}

const dragDrinksUp = () => dragUp(grip("b"));

/** Drop Drinks above Ceremony and hold its settle a tenth of the way in. */
async function settleDrinks() {
  const { at } = await dragDrinksUp();
  await mouse("mouseReleased", at);
  const run = settling(row("b"))!;
  run.pause();
  run.currentTime = Number(run.effect!.getComputedTiming().duration) / 10;
  const seen = row("b").getBoundingClientRect();
  const slot = { top: seen.top - shown(row("b")).y, left: seen.left - shown(row("b")).x };
  expect(Math.abs(seen.top - slot.top), "caught too late to show a jump").toBeGreaterThan(4);
  return { seen, slot };
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
    "starts the settle at the release offset, lifted, and ends at none at rest ($name)",
    async ({ name, width, height, scheme }) => {
      await page.viewport(width, height);
      await commands.emulateMedia({ colorScheme: scheme });
      render(() => <List />);

      const { at, box: released } = await dragDrinksUp();
      const lifted = look(row("b"));
      expect(lifted.shadow, "the stand-in row is not lifted while dragged").not.toBe("none");
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

      // The first frame is where the row was let go, drift and all, and the row
      // still wears the look it was dragged in.
      const first = shown(row("b"));
      expect(Math.abs(first.x)).toBeGreaterThan(4);
      expect(Math.abs(first.y)).toBeGreaterThan(4);
      expect(look(row("b"))).toEqual(lifted);

      // It lands over Ceremony, which now sits below it and is positioned: the
      // lift's stacking, still on, shows Drinks in the overlap, not Ceremony
      // painted over it.
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
      // Landed: the lifted look is gone.
      expect(look(row("b")).shadow).toBe("none");
      expect(look(row("b")).fill).not.toBe(lifted.fill);
    },
  );

  it("lands at once under reduced motion", async () => {
    await page.viewport(1280, 900);
    await commands.emulateMedia({ reducedMotion: "reduce" });
    render(() => <List />);

    const pointer = nextPointer();
    const { at } = await dragDrinksUp();
    end("pointerup", pointer);

    // Read in the release's own task: the host's global clamp would end a
    // settle that started anyway within a frame, so only here does a settle
    // that should not have started still show.
    expect(order()).toEqual(["b", "a", "c", "d"]);
    expect(settling(row("b"))).toBeUndefined();
    expect(row("b").style.transform).toBe("");
    expect(row("b").style.transition).toBe("");
    expect(getComputedStyle(row("b")).transform).toBe("none");
    await mouse("mouseReleased", at);
    // The clamp gives every property a 0.01ms transition, the lift's shadow
    // among them, so the look is read once a frame has run.
    await new Promise(requestAnimationFrame);
    expect(look(row("b")).shadow).toBe("none");
  });

  it("is caught mid-settle by a new drag without a jump", async () => {
    await page.viewport(1280, 900);
    render(() => <List />);
    const { seen } = await settleDrinks();

    // Pressed where it is seen: it stays there, still lifted.
    const press = centre(grip("b"));
    await mouse("mouseMoved", press);
    await mouse("mousePressed", press);
    expect(settling(row("b"))).toBeUndefined();
    let box = row("b").getBoundingClientRect();
    expect(box.top).toBeCloseTo(seen.top, 0);
    expect(box.left).toBeCloseTo(seen.left, 0);
    expect(look(row("b")).shadow).not.toBe("none");

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

  it.each(["pointerup", "pointercancel"] as const)(
    "eases a settling row it was pressed on back to its slot when the press ends unmoved (%s)",
    async (type) => {
      await page.viewport(1280, 900);
      render(() => <List />);
      const { seen, slot } = await settleDrinks();

      const pointer = nextPointer();
      const press = centre(grip("b"));
      await mouse("mouseMoved", press);
      await mouse("mousePressed", press);
      end(type, pointer);

      // Not a drag, so no move; but the row was off its slot, and it eases
      // back from where it was caught rather than staying there.
      expect(order()).toEqual(["b", "a", "c", "d"]);
      const run = settling(row("b"));
      expect(run, "the caught row was left off its slot").toBeDefined();
      run!.pause();
      run!.currentTime = 0;
      expect(shown(row("b")).y).toBeCloseTo(seen.top - slot.top, 0);
      expect(shown(row("b")).x).toBeCloseTo(seen.left - slot.left, 0);
      run!.finish();
      await run!.finished;
      expect(getComputedStyle(row("b")).transform).toBe("none");
      expect(row("b").style.transform).toBe("");
      expect(row("b").style.transition).toBe("");
      expect(look(row("b")).shadow).toBe("none");
      await mouse("mouseReleased", press);
    },
  );

  it("snaps another settling row to its slot before a new drag measures the list", async () => {
    await page.viewport(1280, 900);
    render(() => <List />);
    const { at } = await dragDrinksUp();
    await mouse("mouseReleased", at);
    expect(order()).toEqual(["b", "a", "c", "d"]);
    const run = settling(row("b"))!;
    run.pause();
    run.currentTime = 0;
    expect(Math.abs(shown(row("b")).y)).toBeGreaterThan(4);

    // Dinner is picked up while Drinks is still off its slot.
    const press = centre(grip("c"));
    await mouse("mouseMoved", press);
    await mouse("mousePressed", press);
    expect(settling(row("b"))).toBeUndefined();
    expect(shown(row("b")).x).toBeCloseTo(0, 5);
    expect(shown(row("b")).y).toBeCloseTo(0, 5);
    expect(look(row("b")).shadow).toBe("none");

    // Dinner moves up a row: Ceremony steps aside by exactly one row and its
    // gap, which only a snapshot taken with Drinks in its slot measures.
    const stride = row("a").offsetTop - row("b").offsetTop;
    await mouse("mouseMoved", { x: press.x, y: press.y - 10 });
    await mouse("mouseMoved", { x: press.x, y: press.y - 40 });
    expect(shown(row("a")).y).toBeCloseTo(stride, 0);
    await mouse("mouseReleased", { x: press.x, y: press.y - 40 });
    expect(order()).toEqual(["b", "c", "a", "d"]);
  });

  it("eases a cancelled drag back to the slot it left", async () => {
    await page.viewport(1280, 900);
    render(() => <List />);
    const pointer = nextPointer();

    const { at, box: released } = await dragDrinksUp();
    end("pointercancel", pointer);

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

describe("a page without the app's motion tokens", () => {
  it("settles on the shared contract's `--ui-dur-base` and `--ui-ease-out`", async () => {
    await page.viewport(1280, 900);
    render(() => <List style={{ "--dur-base": "initial", "--ease-out": "initial" }} />);

    const pointer = nextPointer();
    const { at } = await dragDrinksUp();
    end("pointerup", pointer);

    const run = settling(row("b"));
    expect(run, "no settle without the app's tokens").toBeDefined();
    const box = document.querySelector("[data-box]")!;
    const shared = computedTiming("--ui-dur-base", "--ui-ease-out", box);
    expect(shared.duration, "the probe read the app's rung").not.toBe(
      computedTiming("--dur-base", "--ease-out").duration,
    );
    expect(getComputedStyle(row("b")).transitionDuration).toBe(shared.duration);
    expect(getComputedStyle(row("b")).transitionTimingFunction).toBe(shared.easing);
    run!.finish();
    await run!.finished;
    await mouse("mouseReleased", at);
  });

  it("lands at once and leaves nothing inline when neither set of tokens is there", async () => {
    await page.viewport(1280, 900);
    render(() => (
      <List
        style={{
          "--dur-base": "initial",
          "--ease-out": "initial",
          "--ui-dur-base": "initial",
          "--ui-ease-out": "initial",
        }}
      />
    ));

    const pointer = nextPointer();
    const { at } = await dragDrinksUp();
    end("pointerup", pointer);

    expect(order()).toEqual(["b", "a", "c", "d"]);
    expect(settling(row("b"))).toBeUndefined();
    expect(row("b").style.transition).toBe("");
    expect(getComputedStyle(row("b")).transform).toBe("none");
    expect(look(row("b")).shadow).toBe("none");
    await mouse("mouseReleased", at);
  });
});

describe("the budget, a portal list", () => {
  const item = (id: string, name: string, sortOrder: number) => ({
    id,
    weddingId: "wed_1",
    category: "venue",
    name,
    estimateMinor: null,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    sortOrder,
    createdAt: 1,
    updatedAt: 1,
  });

  beforeEach(() => {
    setCachedBudget("wed_1", {
      items: [
        item("it_a", "Reception venue", 0),
        item("it_b", "Ceremony venue", 1),
        item("it_c", "Marquee", 2),
      ],
      payments: [],
      budgetTotalMinor: null,
      currency: "GBP",
    });
    authFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
  });

  afterEach(() => {
    authFetch.mockReset();
    __resetBudgetCache();
  });

  it("puts the dropped row in its new slot before it settles, and keeps it lifted until it lands", async () => {
    await page.viewport(1280, 900);
    render(() => (
      <div class="bg-bg text-text p-6">
        <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />
      </div>
    ));
    const list = await screen.findByTestId("budget-venue");
    const names = () =>
      [...list.querySelectorAll(":scope > li")].map(
        (li) => li.querySelector("span.text-text")?.textContent,
      );
    const budgetRow = (name: string) =>
      [...list.querySelectorAll<HTMLElement>(":scope > li")].find((li) =>
        li.textContent?.includes(name),
      )!;
    expect(names()).toEqual(["Reception venue", "Ceremony venue", "Marquee"]);

    const { at, box: released } = await dragUp(gripIn(budgetRow("Ceremony venue")));
    const lifted = look(budgetRow("Ceremony venue"));
    await mouse("mouseReleased", at);

    expect(names()).toEqual(["Ceremony venue", "Reception venue", "Marquee"]);
    const moved = budgetRow("Ceremony venue");
    const run = settling(moved);
    expect(run, "the row jumped into its slot").toBeDefined();
    run!.pause();
    run!.currentTime = 0;
    const first = shown(moved);
    expect(look(moved), "the row lost its lifted look before it landed").toEqual(lifted);
    await page.screenshot({ path: `${ARTIFACTS}/budget-first-frame-desktop-light.png` });

    run!.finish();
    await run!.finished;
    const slot = moved.getBoundingClientRect();
    // From the release into the NEW slot: a list that moved the row later
    // would settle it into the old one, and these would be a row apart.
    expect(first.x).toBeCloseTo(released.left - slot.left, 0);
    expect(first.y).toBeCloseTo(released.top - slot.top, 0);
    expect(getComputedStyle(moved).transform).toBe("none");
    expect(look(moved).shadow).toBe("none");
  });
});
