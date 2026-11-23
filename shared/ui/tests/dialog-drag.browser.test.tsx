/**
 * Dragging a `Dialog` sheet down to dismiss it, in real Chromium at a phone's
 * 390px (the owner's design on #2288).
 *
 * Every touch goes through the browser's own input pipeline over the DevTools
 * protocol (`Input.dispatchTouchEvent`), so `touch-action`, the browser's own
 * scroll and pointer capture decide what reaches the page, as on a phone. Each
 * event carries a scripted timestamp, so a flick's speed is the one written
 * here, not the test runner's round trips. Where a case reads the sheet
 * between moves, it reads the panel's computed transform, which the drag
 * writes inline on every move.
 *
 * Every case was seen to fail against the bug it names: the drag switched
 * off, or the one guard it holds removed.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, For, type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../src/ui/dialog";
import { emulateMedia, frames, wait } from "./test-support/motion";

import "./test-support/tailwind.css";

const shot = (name: string) => `__screenshots__/dialog-drag.browser.test.tsx/${name}.png`;

afterEach(async () => {
  await cdp()
    .send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
    .catch(() => {});
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

async function atSize(width: number, height = 844) {
  await page.viewport(width, height);
  await vi.waitFor(() => {
    if (innerWidth !== width) throw new Error("viewport not resized yet");
  });
}

interface Point {
  x: number;
  y: number;
}

/** This frame's point in the top-level page, where CDP input lands. */
function toTop(p: Point): Point {
  const frame = window.frameElement?.getBoundingClientRect();
  if (!frame) return p;
  const scale = frame.width / innerWidth;
  return { x: frame.left + p.x * scale, y: frame.top + p.y * scale };
}

/** The last timestamp sent, in seconds; each sequence starts after it, so time never runs back. */
let clock = 0;

/** A finger, driven one event at a time on a scripted clock. */
function finger() {
  let t = Math.max(Date.now() / 1000, clock + 0.05);
  let at: Point = { x: 0, y: 0 };
  const send = async (type: "touchStart" | "touchMove" | "touchEnd", point?: Point) => {
    clock = t;
    // Sent no earlier than its own time, so the page's clock and the script's
    // agree and no event waits on another.
    const ahead = t * 1000 - Date.now();
    if (ahead > 0) await wait(ahead);
    return cdp().send("Input.dispatchTouchEvent", {
      type,
      timestamp: t,
      touchPoints: point ? [{ ...toTop(point), id: 1, radiusX: 1, radiusY: 1, force: 1 }] : [],
    });
  };
  return {
    async down(p: Point) {
      at = p;
      await send("touchStart", p);
    },
    /** Moves to `p`, `ms` after the last event. */
    async to(p: Point, ms = 16) {
      t += ms / 1000;
      at = p;
      await send("touchMove", p);
    },
    /** Moves by `dy` in `steps` moves `ms` apart, calling `each` after each. */
    async by(dy: number, steps: number, ms = 16, each?: (moved: number) => void) {
      const from = at;
      for (let i = 1; i <= steps; i++) {
        await this.to({ x: from.x, y: from.y + (dy * i) / steps }, ms);
        each?.((dy * i) / steps);
      }
    },
    /** Lifts `ms` after the last event; held still that long, the finger lifts with no speed. */
    async up(ms = 16) {
      t += ms / 1000;
      await send("touchEnd");
    },
    get at() {
      return at;
    },
  };
}

/** A mouse button pressed at `from`, moved to `to` in `steps`, held, and let go. */
async function mouseDrag(from: Point, to: Point, steps: number, each?: () => void) {
  const a = toTop(from);
  const b = toTop(to);
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...a,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= steps; i++) {
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: a.x + ((b.x - a.x) * i) / steps,
      y: a.y + ((b.y - a.y) * i) / steps,
      button: "left",
      buttons: 1,
    });
    each?.();
  }
  await wait(150);
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...b,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');
const sheet = () => {
  const found = panel();
  if (!found) throw new Error("no sheet");
  return found;
};

/** The scrim, which Kobalte draws just before the panel. */
function scrimOf(el: HTMLElement): HTMLElement {
  const scrim = el.previousElementSibling;
  if (!(scrim instanceof HTMLElement) || getComputedStyle(scrim).position !== "fixed") {
    throw new Error("no scrim before the sheet");
  }
  return scrim;
}

/** How far below its rest the sheet is drawn, px. */
function offset(el = sheet()): number {
  const t = getComputedStyle(el).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
}

const opacity = (el: HTMLElement) => Number(getComputedStyle(el).opacity);

/** The middle of the sheet's title row. */
function handle(el = sheet()): Point {
  const r = el.querySelector("[data-dialog-header]")!.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function centre(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The inline properties the drag writes, read off the panel and its scrim. */
function owned(el = sheet()) {
  const s = el.style;
  const veil = scrimOf(el).style;
  return {
    panel: [s.transform, s.transition, s.animationDuration, s.opacity, s.boxShadow],
    scrim: [veil.opacity, veil.transition, veil.animationDuration],
  };
}
const NOTHING_OWNED = { panel: ["", "", "", "", ""], scrim: ["", "", ""] };

/**
 * Every run on the sheet and its scrim, ended. A transition can start a frame
 * after the change that made it, so a run still pending counts as running.
 */
async function settled(el = sheet()) {
  await frames();
  await vi.waitFor(
    async () => {
      const runs = [...el.getAnimations(), ...scrimOf(el).getAnimations()].filter(
        (a) => a.playState !== "finished",
      );
      if (runs.length > 0) {
        await Promise.all(runs.map((a) => a.finished.catch(() => undefined)));
        throw new Error("still moving");
      }
    },
    { timeout: 3000 },
  );
  await frames();
}

/** Back at rest, with nothing of the drag's left on it. */
async function atRest(el = sheet()) {
  await vi.waitFor(
    () => {
      expect(owned(el)).toEqual(NOTHING_OWNED);
      expect(offset(el)).toBe(0);
    },
    { timeout: 3000 },
  );
}

async function gone() {
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 3000 });
}

/** A body that fits: one sentence. A tall one: thirty rows, past the 85% cap. */
function Body(props: { tall?: boolean; field?: boolean }) {
  return (
    <>
      {props.field ? (
        <div class="flex flex-col gap-1 p-4">
          <label for="name">Name</label>
          <input id="name" class="h-10 border" />
        </div>
      ) : null}
      {props.tall ? (
        <div class="flex flex-col py-2">
          <For each={Array.from({ length: 30 }, (_, i) => i + 1)}>
            {(n) => (
              <button type="button" class="h-14 w-full text-left">
                Profile {n}
              </button>
            )}
          </For>
        </div>
      ) : (
        <p class="p-4">Your RSVP is removed and the host is told.</p>
      )}
    </>
  );
}

let leaves = 0;

/** A sheet with a trigger, a title row with a close glyph, a body and two actions. */
function UncontrolledSheet(props: {
  tall?: boolean;
  field?: boolean;
  dismissible?: boolean;
  presentation?: "sheet" | "centred";
}) {
  return (
    <Dialog>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent presentation={props.presentation ?? "sheet"} dismissible={props.dismissible}>
        <SheetParts {...props} />
      </DialogContent>
    </Dialog>
  );
}

function SheetParts(props: { tall?: boolean; field?: boolean }): JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Leave this event?</DialogTitle>
        <DialogClose aria-label="Close" treatment="glyph">
          ×
        </DialogClose>
      </DialogHeader>
      <Body tall={props.tall} field={props.field} />
      <DialogFooter>
        <DialogClose>Stay</DialogClose>
        <button type="button" class="h-10 px-4" onClick={() => leaves++}>
          Leave
        </button>
      </DialogFooter>
    </>
  );
}

/** Renders an uncontrolled sheet, opens it from its trigger, and waits for it to rise. */
async function openSheet(props: Parameters<typeof UncontrolledSheet>[0] = {}) {
  leaves = 0;
  render(() => <UncontrolledSheet {...props} />);
  const trigger = screen.getByRole("button", { name: "Open" });
  await userEvent.click(trigger);
  const el = await vi.waitFor(sheet, { timeout: 3000 });
  await settled(el);
  return { el, trigger, height: el.offsetHeight };
}

describe("a sheet dragged by its title row", () => {
  it("follows the finger to the pixel, and its scrim fades with it", async () => {
    await atSize(390);
    const { el, height } = await openSheet();
    const top0 = el.getBoundingClientRect().top;
    const f = finger();
    await f.down(handle(el));
    let worst = 0;
    let scrimAtHalf = 1;
    await f.by(height * 0.5, 25, 16, (moved) => {
      worst = Math.max(worst, Math.abs(el.getBoundingClientRect().top - top0 - moved));
      scrimAtHalf = opacity(scrimOf(el));
    });
    expect(worst, "the panel strayed from the finger").toBeLessThanOrEqual(1);
    expect(scrimAtHalf).toBeGreaterThan(0.4);
    expect(scrimAtHalf).toBeLessThan(0.6);
    await page.screenshot({ path: shot("mid-drag-390-light") });
    await f.up(150);
  });

  it("let go slowly past a quarter of its height, carries on down on the spring and gives focus back", async () => {
    await atSize(390);
    const { el, trigger, height } = await openSheet();
    const f = finger();
    await f.down(handle(el));
    await f.by(height * 0.5, 25);
    await wait(150);
    const released = offset(el);
    await f.up(150);
    // The exit's timing is the spring's, on the panel's transitions and its
    // run alike, so Kobalte keeps it mounted until it has left.
    const time = el.style.transitionDuration;
    expect(time).toMatch(/ms$/);
    expect(el.style.animationDuration).toBe(time);
    expect(scrimOf(el).style.animationDuration).toBe(time);
    expect(Number.parseFloat(time)).toBeGreaterThan(300);
    expect(Number.parseFloat(time)).toBeLessThan(460);
    expect(el.style.transitionTimingFunction).toMatch(/^linear\(/);
    await wait(60);
    expect(offset(el), "it did not carry on down from where it was let go").toBeGreaterThan(
      released,
    );
    // Past the class's 200ms exit, it is still on its way out.
    await wait(180);
    expect(panel(), "it was unmounted before the spring ended").not.toBeNull();
    await gone();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("let go short, goes back to rest and leaves nothing of the drag on it", async () => {
    await atSize(390);
    const { el } = await openSheet();
    const kobalte = el.style.pointerEvents;
    const header = el.style.getPropertyValue("--ui-dialog-header-height");
    const f = finger();
    await f.down(handle(el));
    await f.by(30, 6);
    await f.up(150);
    await atRest(el);
    expect(el.style.pointerEvents).toBe(kobalte);
    expect(el.style.getPropertyValue("--ui-dialog-header-height")).toBe(header);
    // Cancel still closes on the class's own exit.
    await userEvent.click(screen.getByText("Stay"));
    const exit = getComputedStyle(el);
    expect(exit.transitionDuration.split(",")[0]).toBe("0.2s");
    expect(exit.transitionTimingFunction.split(", cubic")[0]).toBe(
      "cubic-bezier(0.32, 0.72, 0, 1)",
    );
    await gone();
  });

  it("flicked down a short way, closes", async () => {
    await atSize(390);
    const { el, height } = await openSheet();
    const f = finger();
    await f.down(handle(el));
    await f.by(36, 3, 8);
    expect(offset(el)).toBeLessThan(height * 0.25);
    await f.up(8);
    await gone();
  });

  it("pulled past a quarter and flicked back up at the end, stays open", async () => {
    await atSize(390);
    const { el, height } = await openSheet();
    const f = finger();
    await f.down(handle(el));
    await f.by(height * 0.6, 20);
    await f.by(-30, 3, 8);
    expect(offset(el)).toBeGreaterThan(height * 0.25);
    await f.up(8);
    await atRest(el);
    expect(panel()).not.toBeNull();
  });

  it("taps the close glyph in the title row, a few pixels of jitter and all", async () => {
    await atSize(390);
    const { el } = await openSheet();
    const glyph = screen.getByRole("button", { name: "Close" });
    const f = finger();
    await f.down(centre(glyph));
    await f.by(3, 1);
    await f.up(40);
    await gone();
    expect(el.isConnected).toBe(false);
  });

  it("follows a mouse too, and closes on it", async () => {
    await atSize(390);
    const { el, trigger, height } = await openSheet();
    const from = handle(el);
    const top0 = el.getBoundingClientRect().top;
    let worst = 0;
    let step = 0;
    await mouseDrag(from, { x: from.x, y: from.y + height * 0.45 }, 20, () => {
      step++;
      worst = Math.max(
        worst,
        Math.abs(el.getBoundingClientRect().top - top0 - (height * 0.45 * step) / 20),
      );
    });
    expect(worst).toBeLessThanOrEqual(1);
    await gone();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("a moving sheet", () => {
  it("is caught by a finger that moves, and follows it from where it was", async () => {
    await atSize(390);
    const { el } = await openSheet();
    const f = finger();
    await f.down(handle(el));
    await f.by(40, 5);
    await f.up(150);
    await wait(45);
    const g = finger();
    await g.down(handle(el));
    await g.by(2, 1);
    const caught = offset(el);
    expect(caught, "it had already landed").toBeGreaterThan(1);
    await wait(150);
    expect(Math.abs(offset(el) - caught), "it went on settling under the finger").toBeLessThan(0.5);
    await g.by(30, 3);
    expect(Math.abs(offset(el) - (caught + 30))).toBeLessThanOrEqual(1);
    await g.up(150);
    await atRest(el);
  });

  it("lets a tap during its return land, and the tap's click through", async () => {
    await atSize(390);
    const { el } = await openSheet();
    const f = finger();
    await f.down(handle(el));
    await f.by(20, 4);
    await f.up(150);
    await wait(45);
    const leave = screen.getByRole("button", { name: "Leave" });
    expect(offset(el), "it had already landed").toBeGreaterThan(1);
    const g = finger();
    await g.down(centre(leave));
    await g.up(40);
    await atRest(el);
    // A desktop Chromium holds a tap's click back for a double tap.
    await vi.waitFor(() => expect(leaves, "the tap's click was swallowed").toBe(1), {
      timeout: 1000,
    });
  });
});

describe("a sheet whose body scrolls", () => {
  it("scrolls its list by touch, and drags only from its title row while scrolled", async () => {
    await atSize(390);
    const { el } = await openSheet({ tall: true });
    expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;

    // Up inside the list: the list scrolls, the sheet stays.
    const f = finger();
    await f.down({ x, y: box.bottom - 160 });
    let moved = 0;
    await f.by(-260, 20, 16, () => (moved = Math.max(moved, Math.abs(offset(el)))));
    await f.up(150);
    await vi.waitFor(() => expect(el.scrollTop).toBeGreaterThan(50), { timeout: 3000 });
    expect(moved).toBeLessThan(0.5);
    await wait(600);
    const scrolled = el.scrollTop;
    await page.screenshot({ path: shot("tall-scrolled-390-light") });

    // Down inside the scrolled list: it scrolls back, the sheet stays.
    const g = finger();
    await g.down({ x, y: box.top + 300 });
    await g.by(96, 12, 16, () => (moved = Math.max(moved, Math.abs(offset(el)))));
    await g.up(150);
    await wait(600);
    expect(el.scrollTop).toBeLessThan(scrolled);
    expect(moved, "a drag in a scrolled list moved the sheet").toBeLessThan(0.5);

    // The title row drags it, however far the list is scrolled.
    const before = el.scrollTop;
    const h = finger();
    await h.down(handle(el));
    await h.by(60, 6);
    expect(Math.abs(offset(el) - 60)).toBeLessThanOrEqual(1);
    expect(el.scrollTop).toBe(before);
    await h.up(150);
    await atRest(el);
  });

  it("at the top of its list, moves with a pull down the list, from where the slop let it go", async () => {
    await atSize(390);
    const { el } = await openSheet({ tall: true });
    const box = el.getBoundingClientRect();
    const k = finger();
    await k.down({ x: box.left + box.width / 2, y: box.top + 300 });
    await k.by(8, 1);
    expect(offset(el), "it moved inside the slop").toBe(0);
    await k.by(8, 1);
    const start = offset(el);
    expect(start, "it jumped as the drag began").toBeLessThanOrEqual(1);
    let scrolledBy = 0;
    await k.by(64, 8, 16, () => (scrolledBy = Math.max(scrolledBy, el.scrollTop)));
    expect(Math.abs(offset(el) - start - 64)).toBeLessThanOrEqual(1);
    expect(scrolledBy, "the list scrolled under the drag").toBe(0);
    await k.up(150);
    await atRest(el);
  });

  it("at its top, a press that goes down then turns up still drags it, up on the band", async () => {
    await atSize(390);
    const { el } = await openSheet();
    const body = el.querySelector("p")!;
    const f = finger();
    await f.down(centre(body));
    await f.by(4, 1);
    await f.by(-40, 5);
    expect(offset(el), "the press went dead").toBeLessThan(-1);
    expect(offset(el), "it followed the finger past rest").toBeGreaterThan(-40);
    await f.up(150);
    await atRest(el);
  });

  it("leaves a drag that starts in a text field to the field", async () => {
    await atSize(390);
    const { el } = await openSheet({ field: true });
    const field = screen.getByLabelText("Name");
    field.focus();
    const f = finger();
    await f.down(centre(field));
    let moved = 0;
    await f.by(120, 10, 16, () => (moved = Math.max(moved, Math.abs(offset(el)))));
    await f.up(150);
    expect(moved).toBeLessThan(0.5);
    expect(document.activeElement).toBe(field);
  });
});

describe("a sheet that cannot close", () => {
  it("gives with resistance and goes back; Escape and the scrim do nothing", async () => {
    await atSize(390);
    const { el } = await openSheet({ dismissible: false });
    const f = finger();
    await f.down(handle(el));
    await f.by(150, 10);
    const pulled = offset(el);
    expect(pulled).toBeGreaterThan(10);
    expect(pulled).toBeLessThan(90);
    await wait(100);
    await f.up(16);
    await atRest(el);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(scrimOf(el), { position: { x: 20, y: 20 } });
    await wait(300);
    expect(panel()).toBe(el);
  });

  it("when its host refuses in onOpenChange, goes back and drags again", async () => {
    await atSize(390);
    const asked: boolean[] = [];
    render(() => (
      <Dialog open onOpenChange={(next) => asked.push(next)}>
        <DialogContent presentation="sheet">
          <SheetParts />
        </DialogContent>
      </Dialog>
    ));
    const el = await vi.waitFor(sheet);
    await settled(el);
    const height = el.offsetHeight;
    const f = finger();
    await f.down(handle(el));
    await f.by(height * 0.5, 20);
    await f.up(150);
    expect(asked).toEqual([false]);
    await atRest(el);
    const g = finger();
    await g.down(handle(el));
    await g.by(30, 3);
    expect(Math.abs(offset(el) - 30)).toBeLessThanOrEqual(1);
    await g.up(150);
    await atRest(el);
  });
});

describe("a sheet that changes its mind", () => {
  it("closed by Escape in the middle of a drag, leaves on the class's exit from where it is", async () => {
    await atSize(390);
    const { el } = await openSheet();
    const f = finger();
    await f.down(handle(el));
    await f.by(60, 6);
    await userEvent.keyboard("{Escape}");
    expect(owned(el)).toEqual(NOTHING_OWNED);
    expect(getComputedStyle(el).transitionDuration.split(",")[0]).toBe("0.2s");
    expect(offset(el), "it jumped back to rest first").toBeGreaterThan(50);
    await f.up(16);
    await gone();
  });

  it("reopened as it leaves after a drag, turns round and drags again", async () => {
    await atSize(390);
    const [open, setOpen] = createSignal(true);
    render(() => (
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent presentation="sheet">
          <SheetParts />
        </DialogContent>
      </Dialog>
    ));
    const el = await vi.waitFor(sheet);
    await settled(el);
    const f = finger();
    await f.down(handle(el));
    await f.by(el.offsetHeight * 0.5, 20);
    await f.up(150);
    await wait(80);
    expect(open()).toBe(false);
    setOpen(true);
    await settled(el);
    await atRest(el);
    expect(panel()).toBe(el);
    const g = finger();
    await g.down(handle(el));
    await g.by(30, 3);
    expect(Math.abs(offset(el) - 30)).toBeLessThanOrEqual(1);
    await g.up(150);
    await atRest(el);
  });
});

describe("what never drags", () => {
  it("the centred card at md and up", async () => {
    await atSize(1024, 800);
    const { el } = await openSheet();
    const top0 = el.getBoundingClientRect().top;
    const f = finger();
    await f.down(handle(el));
    let moved = 0;
    await f.by(
      150,
      10,
      16,
      () => (moved = Math.max(moved, Math.abs(el.getBoundingClientRect().top - top0))),
    );
    await f.up(150);
    expect(moved).toBeLessThan(0.5);
    await userEvent.keyboard("{Escape}");
    await gone();
  });
});

describe("under reduced motion", () => {
  it("follows the finger, fades where it was let go, and dips back from a short drag", async () => {
    await atSize(390);
    await emulateMedia({ reducedMotion: "reduce" });
    const { el, height } = await openSheet();
    const top0 = el.getBoundingClientRect().top;
    const f = finger();
    await f.down(handle(el));
    let worst = 0;
    await f.by(40, 5, 16, (moved) => {
      worst = Math.max(worst, Math.abs(el.getBoundingClientRect().top - top0 - moved));
    });
    expect(worst).toBeLessThanOrEqual(1);
    await f.up(150);
    // A short drag dips: out where it is, to rest unseen, back in. Nothing
    // is ever drawn between the two places.
    const seen: { y: number; o: number }[] = [];
    const deadline = performance.now() + 600;
    while (performance.now() < deadline) {
      seen.push({ y: offset(el), o: opacity(el) });
      await frames(1);
    }
    expect(
      seen.some((s) => s.o < 1 && Math.abs(s.y - 40) < 0.5),
      "it never faded where it was",
    ).toBe(true);
    expect(
      seen.every((s) => Math.abs(s.y - 40) < 0.5 || Math.abs(s.y) < 0.5),
      "it slid",
    ).toBe(true);
    await atRest(el);
    expect(opacity(el)).toBe(1);

    // A long one closes by fading where it was let go.
    const g = finger();
    await g.down(handle(el));
    await g.by(height * 0.5, 20);
    await wait(150);
    const released = offset(el);
    await g.up(150);
    await wait(60);
    const a = { y: offset(el), o: opacity(el) };
    await wait(60);
    const b = { y: offset(el), o: opacity(el) };
    expect(Math.abs(a.y - released)).toBeLessThan(0.5);
    expect(Math.abs(b.y - released)).toBeLessThan(0.5);
    expect(a.o).toBeLessThan(1);
    expect(b.o).toBeLessThan(a.o);
    await gone();
  });
});
