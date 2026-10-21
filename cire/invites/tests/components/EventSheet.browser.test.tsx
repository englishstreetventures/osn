/**
 * The event sheet's switch between its two panels, in a real engine.
 *
 * `EventSheet.test.tsx` holds the state: what mounts, what is hidden, which
 * heading is handed focus. None of what is below exists in jsdom — no
 * `<dialog>` modality, no layout to hide a panel from, no animation to slide
 * one in, no focus restore when the dialog closes, no reduced-motion clamp —
 * and each is part of what the issue asked for: the guest moves between the
 * panels without the dialog closing, focus lands on the new heading and goes
 * back to the opener on close, nothing typed is lost, the move is animated,
 * under reduced motion it is instant, and the sheet keeps one height.
 */
import { cleanup, render, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { EventCard } from "../../src/components/EventCard";
import { EventSheet, type EventPanel } from "../../src/components/EventSheet";
import type { EventSummary, FamilyMember } from "../../src/components/types";

/** Typed accessor for the command registered in `vitest.config.ts`. */
const emulate = (options: { reducedMotion?: "reduce" | "no-preference" }) =>
  (commands as unknown as { emulateMedia: (o: typeof options) => Promise<void> }).emulateMedia(
    options,
  );

const PHONE = [414, 896] as const;

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "Henna evening",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane, Strathfield",
  dressCodeDescription: "Festive colours",
  dressCodePalette: [{ name: "Marigold", color: "#e8a33d" }],
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
};

/** Enough of a party that the RSVP form scrolls inside the sheet. */
const party: FamilyMember[] = Array.from({ length: 10 }, (_, i) => ({
  guestId: `guest-${i}`,
  firstName: `Guest${i}`,
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
}));

/**
 * The card and the sheet, wired the way the page wires them: each of the
 * card's buttons opens the sheet on its own panel, and a close clears it.
 */
function Harness(props: { members?: FamilyMember[]; event?: EventSummary }) {
  const [sheet, setSheet] = createSignal<EventPanel | null>(null);
  return (
    <>
      <EventCard
        event={props.event ?? event}
        onRespond={() => setSheet("rsvp")}
        onDetails={() => setSheet("details")}
      />
      <Show when={sheet()} keyed>
        {(panel) => (
          <EventSheet
            event={props.event ?? event}
            panel={panel}
            siteUrl="https://invite.test/w"
            members={props.members ?? [priya]}
            apiUrl="https://api.test"
            onClose={() => setSheet(null)}
          />
        )}
      </Show>
    </>
  );
}

function dialog(): HTMLDialogElement {
  const el = document.querySelector("dialog");
  if (!el) throw new Error("no sheet open");
  return el;
}

function scroller(): HTMLElement {
  return dialog().lastElementChild as HTMLElement;
}

function wrapperOf(panel: EventPanel): HTMLElement {
  return dialog().querySelector<HTMLElement>(`[data-panel="${panel}"]`)!;
}

function button(name: string | RegExp): HTMLButtonElement {
  return within(document.body).getByRole("button", { name }) as HTMLButtonElement;
}

function cardButton(label: string): HTMLButtonElement {
  return [...document.querySelectorAll("article button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

/**
 * Wait until nothing that ends is still moving. A frame first, because an
 * animation has not started until style has been resolved. Endless ones are
 * left out — none is expected here, but one would hang the wait.
 */
async function settle() {
  await new Promise(requestAnimationFrame);
  const running = dialog()
    .getAnimations({ subtree: true })
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
  await Promise.allSettled(running.map((a) => a.finished));
  await new Promise(requestAnimationFrame);
}

/** `close` lands in a task after the Escape that caused it. */
const afterTheCloseEvent = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  cleanup();
  document.documentElement.style.overflow = "";
  await emulate({ reducedMotion: "no-preference" });
});

describe("EventSheet — moving between the panels", () => {
  it("goes from the details to the form and back inside one open dialog, losing nothing", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);

    await userEvent.click(cardButton("Event Details"));
    await settle();
    const sheet = dialog();
    expect(sheet.matches(":modal")).toBe(true);

    await userEvent.click(button("Give RSVP"));
    expect(document.activeElement?.textContent).toMatch(/Respond.*Mehndi/);
    expect(document.activeElement?.tagName).toBe("H3");
    await settle();
    expect(dialog()).toBe(sheet);
    expect(sheet.matches(":modal")).toBe(true);
    expect(getComputedStyle(wrapperOf("details")).display).toBe("none");

    // Answer, and type something the server has never seen.
    const fieldset = within(sheet).getByRole("group", { name: /priya sharma/i });
    await userEvent.click(within(fieldset).getByText("Attending"));
    await userEvent.click(within(fieldset).getByText("Other").closest("label") as HTMLElement);
    const other = await within(fieldset).findByPlaceholderText(/no onion/i);
    await userEvent.type(other, "no curry leaves");

    await userEvent.click(button("See details"));
    expect(document.activeElement?.textContent).toMatch(/Details.*Mehndi/);
    await settle();
    expect(getComputedStyle(wrapperOf("rsvp")).display).toBe("none");
    expect(getComputedStyle(wrapperOf("details")).display).not.toBe("none");

    await userEvent.click(button("Give RSVP"));
    await settle();
    const back = within(sheet).getByRole("group", { name: /priya sharma/i });
    expect(within(back).getByText("Attending").getAttribute("aria-pressed")).toBe("true");
    expect((within(back).getByPlaceholderText(/no onion/i) as HTMLInputElement).value).toBe(
      "no curry leaves",
    );
  });

  it("gives focus back to Event Details when closed from the form it led to", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    const opener = cardButton("Event Details");

    await userEvent.click(opener);
    await settle();
    await userEvent.click(button("Give RSVP"));
    await settle();

    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();

    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("gives focus back to Respond when closed from the details it led to", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    const opener = cardButton("Respond");

    await userEvent.click(opener);
    await settle();
    await userEvent.click(button("See details"));
    await settle();

    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();

    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("puts the guest at the top of the panel they move to", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness members={party} />);
    await userEvent.click(cardButton("Respond"));
    await settle();
    scroller().scrollTop = scroller().scrollHeight;
    expect(scroller().scrollTop).toBeGreaterThan(0);

    await userEvent.click(button("See details"));
    await settle();

    expect(scroller().scrollTop).toBe(0);
    const heading = document.activeElement as HTMLElement;
    expect(heading.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      scroller().getBoundingClientRect().top,
    );
  });
});

describe("EventSheet — the motion", () => {
  it("slides the form in from the end, and nothing scrolls sideways while it does", async () => {
    // Details to form is the direction that can overflow: the form arrives
    // from +x carrying its full-bleed action bar past the scrollport's edge.
    // The other direction overflows toward the start, which never scrolls, so
    // a check made there could not fail.
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    button("Give RSVP").click();
    const form = wrapperOf("rsvp");
    const [slide] = form.getAnimations();
    expect((slide as CSSAnimation).animationName).toBe("panel-from-end");
    slide!.pause();
    slide!.currentTime = 0;

    const style = getComputedStyle(form);
    expect(Number(style.opacity)).toBe(0);
    expect(new DOMMatrix(style.transform).m41).toBeGreaterThan(0);
    // Still transparent, so it takes no pointer input yet.
    expect(style.pointerEvents).toBe("none");
    // Nothing to scroll sideways — and the clip that makes it so. Measured
    // first, so a missing clip fails here, on the symptom a guest would see.
    expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth);
    const panels = scroller().firstElementChild as HTMLElement;
    expect(getComputedStyle(panels).overflowX).toBe("clip");

    slide!.finish();
    await settle();
    // Settled: hit-testable again, and nothing is clipped any more.
    expect(getComputedStyle(form).pointerEvents).toBe("auto");
    expect(getComputedStyle(panels).overflowX).toBe("visible");
  });

  it("slides the details in from the start", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Respond"));
    await settle();

    button("See details").click();
    const [slide] = wrapperOf("details").getAnimations();
    expect((slide as CSSAnimation).animationName).toBe("panel-from-start");
    slide!.pause();
    slide!.currentTime = 0;
    expect(new DOMMatrix(getComputedStyle(wrapperOf("details")).transform).m41).toBeLessThan(0);
    slide!.finish();
  });

  it("does not slide in the panel the sheet opens on", async () => {
    // That panel arrives with the sheet's own entry; a second animation on top
    // of it would be two entries at once.
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Respond"));

    expect(wrapperOf("rsvp").getAnimations()).toHaveLength(0);
    await settle();
  });

  it("seats the form's action bar on the scrollport's edge after arriving from the details", async () => {
    // The scrollport has no bottom padding for either panel, so the bar sits
    // on its edge. Measured once the slide is over, because
    // `getBoundingClientRect` reports the box after its transform.
    await page.viewport(...PHONE);
    render(() => <Harness members={party} />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    await userEvent.click(button("Give RSVP"));
    await settle();

    const bar = button("Save").parentElement as HTMLElement;
    const gap = scroller().getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom;
    expect(Math.abs(gap)).toBeLessThan(1);
  });

  it("switches at once under reduced motion", async () => {
    await emulate({ reducedMotion: "reduce" });
    await page.viewport(1280, 900);
    render(() => <Harness />);
    await userEvent.click(cardButton("Respond"));
    await settle();

    button("See details").click();
    const details = wrapperOf("details");
    expect(Number.parseFloat(getComputedStyle(details).animationDuration)).toBeLessThan(0.001);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);

    expect(Number(getComputedStyle(details).opacity)).toBe(1);
    expect(getComputedStyle(details).transform).toBe("none");
    expect(
      dialog()
        .getAnimations()
        .filter((a) => a.playState === "running"),
    ).toHaveLength(0);
  });

  it("lets the details take input once their slide ends, whatever still spins inside them", async () => {
    // The moodboard's loading spinner turns for as long as Pinterest takes.
    // The switch waits on the panel's own slide, never on its contents, or a
    // slow embed would leave the panel the guest asked for unclickable.
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();
    await userEvent.click(button("Give RSVP"));
    await settle();
    const spinner = document.createElement("span");
    wrapperOf("details").append(spinner);
    spinner.animate([{ transform: "rotate(0)" }, { transform: "rotate(1turn)" }], {
      duration: 1000,
      iterations: Infinity,
    });

    button("See details").click();
    const [slide] = wrapperOf("details").getAnimations();
    slide!.finish();
    await settle();

    expect(getComputedStyle(wrapperOf("details")).pointerEvents).toBe("auto");
    const panels = scroller().firstElementChild as HTMLElement;
    expect(getComputedStyle(panels).overflowX).toBe("visible");
  });

  it("keeps a quick switch back mid-slide from lifting the new slide's limits early", async () => {
    // Switching back hides the panel still arriving, which cancels its slide
    // and settles it at once. That settle belongs to the earlier switch and
    // must not clear the state of the one now running.
    await page.viewport(1280, 900);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    button("Give RSVP").click();
    // Hold the first slide halfway, so the switch back lands mid-slide.
    const [first] = wrapperOf("rsvp").getAnimations();
    first!.pause();
    first!.currentTime = 140;
    button("See details").click();
    const [slide] = wrapperOf("details").getAnimations();
    slide!.pause();
    slide!.currentTime = 0;
    await new Promise(requestAnimationFrame);

    expect(getComputedStyle(wrapperOf("details")).pointerEvents).toBe("none");
    const panels = scroller().firstElementChild as HTMLElement;
    expect(getComputedStyle(panels).overflowX).toBe("clip");

    slide!.finish();
    await settle();
  });
});

describe("EventSheet — the badge", () => {
  it("gives it a 44px target on both panels, level with the close button", async () => {
    // A thumb has to hit it; drawn as a small pill, it would otherwise be only
    // as tall as its line of text.
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    const close = button("Close").getBoundingClientRect();
    const give = button("Give RSVP").getBoundingClientRect();
    expect(give.height).toBeGreaterThanOrEqual(44);
    expect(give.top).toBe(close.top);
    expect(give.right).toBeLessThanOrEqual(close.left);
    expect(button(/add to calendar/i).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    await userEvent.click(button("Give RSVP"));
    await settle();
    expect(button("See details").getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  it("is a pill, not the house's square corner", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();
    const badge = button("Give RSVP");
    const radius = Number.parseFloat(getComputedStyle(badge).borderTopLeftRadius);
    expect(radius).toBeGreaterThanOrEqual(badge.getBoundingClientRect().height / 2);
    // Opaque, because the sheet's content scrolls underneath it — and filled
    // like the close button beside it.
    expect(getComputedStyle(badge).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(badge).backgroundColor).toBe(
      getComputedStyle(button("Close")).backgroundColor,
    );
  });

  it("keeps the heading clear of the badge row on a 320px phone", async () => {
    await page.viewport(320, 640);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();
    const row = button("Close").parentElement!.getBoundingClientRect();
    const heading = dialog().querySelector("h3")!.getBoundingClientRect();
    expect(heading.top).toBeGreaterThanOrEqual(row.bottom);
  });

  it.each([
    ["a party taller than the sheet", party],
    // The shortest form there is: the first to move the sheet's edge if its
    // height ever followed its content again, when the second tap would meet
    // the backdrop and close the sheet.
    ["a household of one", [priya]],
  ])("does not take the second tap of a double tap straight back, for %s", async (_, members) => {
    // The badge sits in the same corner on both panels, and the sheet keeps
    // one height, so the second tap of a double tap lands on its twin.
    await page.viewport(...PHONE);
    render(() => <Harness members={members} />);
    await userEvent.click(cardButton("Event Details"));
    await settle();
    const at = centre(button("Give RSVP"));
    await mouseClick(at);
    // A thumb's double tap: the second lands some 60ms after the first.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.elementFromPoint(at.x, at.y)?.closest("button")?.textContent).toContain(
      "See details",
    );
    await mouseClick(at);
    await new Promise(requestAnimationFrame);
    expect(document.querySelector("dialog")?.open).toBe(true);
    await settle();
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);
  });

  it("still closes on a backdrop tap once the panels are still", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();
    await userEvent.click(button("Give RSVP"));
    await settle();
    await mouseClick({ x: 10, y: 10 });
    await afterTheCloseEvent();
    expect(document.querySelector("dialog")).toBeNull();
  });
});

/**
 * What the arriving heading shows after a switch. A heading is never reached by
 * keyboard, so after a touch or a click the ring would read as the heading
 * being selected. Chromium draws none either way; the engines that do (iOS
 * Safari) are out of reach here, so these pin the mechanism: the mark on a
 * pointer's or a swipe's move, none on a key's, and the rule that drops the
 * ring where the mark is.
 */
describe("EventSheet — focus after a switch", () => {
  it("hands the heading focus quietly after a swipe", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    await settleSwipe();

    const heading = wrapperOf("rsvp").querySelector("h3")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute("data-quiet-focus")).toBe(true);
  });

  it("hands the heading focus quietly after a click on the switch", async () => {
    await openOn("details");
    await userEvent.click(button("Give RSVP"));
    await settle();

    const heading = wrapperOf("rsvp").querySelector("h3")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute("data-quiet-focus")).toBe(true);
  });

  it("keeps the ring for a key press on the switch, and drops it only where the mark is", async () => {
    await openOn("details");
    button("Give RSVP").focus();
    await userEvent.keyboard("{Enter}");
    await settle();

    const heading = wrapperOf("rsvp").querySelector("h3")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute("data-quiet-focus")).toBe(false);
    // Reached by keyboard, so the engine draws the ring, and the page's rule
    // paints it.
    expect(heading.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(heading).outlineStyle).toBe("solid");

    // The same focus, marked: the rule in `global.css` takes the ring away.
    heading.setAttribute("data-quiet-focus", "");
    expect(getComputedStyle(heading).outlineStyle).toBe("none");
  });

  it("clears the mark once the heading loses focus", async () => {
    await openOn("details");
    await userEvent.click(button("Give RSVP"));
    await settle();
    const heading = wrapperOf("rsvp").querySelector("h3")!;
    expect(heading.hasAttribute("data-quiet-focus")).toBe(true);

    button("Close").focus();
    expect(heading.hasAttribute("data-quiet-focus")).toBe(false);
  });

  it("drops a text selection as a drag begins, and selects nothing while it runs", async () => {
    // A long press can start a native selection on the panel's text; the drag
    // that follows must not carry it along, highlighted, under the finger.
    await openOn("details");
    const heading = wrapperOf("details").querySelector("h3")!;
    getSelection()!.selectAllChildren(heading);
    expect(getSelection()!.isCollapsed).toBe(false);

    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 120, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);
    try {
      expect(getSelection()!.isCollapsed).toBe(true);
      const rail = wrapperOf("details").parentElement!;
      expect(getComputedStyle(rail).userSelect).toBe("none");
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await settleSwipe();
    }
    // Once still, the text can be selected again (a long press to copy the address).
    expect(getComputedStyle(wrapperOf("details").parentElement!).userSelect).not.toBe("none");
  });
});

// ── Swiping ─────────────────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

function centre(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * This frame's point in the top-level page's coordinates, which is where CDP
 * input lands: the tests run in an iframe that may be offset and scaled.
 */
function toTop(p: Point): Point {
  const frame = window.frameElement?.getBoundingClientRect();
  if (!frame) return p;
  const scale = frame.width / window.innerWidth;
  return { x: frame.left + p.x * scale, y: frame.top + p.y * scale };
}

async function mouseClick(p: Point) {
  const { x, y } = toTop(p);
  const session = cdp();
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

/**
 * A finger from `from` to `to` over `ms`, in `steps` moves, through the
 * browser's real input pipeline — so `touch-action` and the browser's own
 * scroll decide what reaches the page, as on a phone. Each event carries its
 * own timestamp, so the speed is the one written here, not the test runner's.
 * `end` is how the touch finishes; `"hold"` leaves the finger down.
 */
async function touchDrag(
  from: Point,
  to: Point,
  {
    ms = 300,
    steps = 10,
    end = "lift",
  }: { ms?: number; steps?: number; end?: "lift" | "cancel" | "hold" } = {},
) {
  const session = cdp();
  const t0 = Date.now() / 1000;
  const point = (p: Point) => ({ ...toTop(p), id: 1 });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(from)],
    timestamp: t0,
  });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f })],
      timestamp: t0 + (ms / 1000) * f,
    });
  }
  if (end === "hold") return;
  await session.send("Input.dispatchTouchEvent", {
    type: end === "lift" ? "touchEnd" : "touchCancel",
    touchPoints: [],
    timestamp: t0 + ms / 1000 + 0.01,
  });
}

async function mouseDrag(from: Point, to: Point) {
  const session = cdp();
  const a = toTop(from);
  const b = toTop(to);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...a,
    button: "left",
    clickCount: 1,
  });
  for (let i = 1; i <= 10; i++) {
    const f = i / 10;
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      button: "left",
      buttons: 1,
    });
  }
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...b,
    button: "left",
    clickCount: 1,
  });
}

/** A point in the middle of a panel's body, clear of every control. */
function bodyOf(panel: EventPanel): Point {
  const heading = wrapperOf(panel).querySelector("h3")!.getBoundingClientRect();
  return { x: heading.left + heading.width / 2, y: heading.top + heading.height / 2 };
}

/** Wait for the swipe's settle, which is a transition rather than an animation. */
async function settleSwipe() {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle();
}

async function openOn(panel: EventPanel, members?: FamilyMember[]) {
  await page.viewport(...PHONE);
  render(() => <Harness members={members} />);
  await userEvent.click(cardButton(panel === "details" ? "Event Details" : "Respond"));
  await settle();
}

/** Every running animation or transition on `el` itself. */
function moving(el: Element): Animation[] {
  return el.getAnimations().filter((a) => a.playState === "running");
}

describe("EventSheet — swiping between the panels", () => {
  it("keeps the panel under the finger following it when it arrived by a swipe", async () => {
    // A panel that arrived by a swipe and is now swiped away must not replay
    // its entry slide: that would fade it and pull it off the finger.
    await openOn("details");
    let start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);

    start = bodyOf("rsvp");
    // Two moves, read at once: a replayed 280ms slide would still be running.
    await touchDrag(start, { x: start.x + 60, y: start.y }, { steps: 2, end: "hold" });
    await new Promise(requestAnimationFrame);
    const form = wrapperOf("rsvp");
    expect(form.style.transform).toBe("translateX(60px)");
    expect(moving(form)).toEqual([]);
    expect(getComputedStyle(form).opacity).toBe("1");
    expect(form.getBoundingClientRect().left - scroller().getBoundingClientRect().left).toBeCloseTo(
      60 + Number.parseFloat(getComputedStyle(scroller()).paddingLeft),
      0,
    );

    await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await settleSwipe();
  });

  it("draws the details level with the top of a scrolled form, clipped at its sides", async () => {
    await openOn("rsvp", party);
    scroller().scrollTop = 200;
    const start = bodyOf("rsvp");
    // The heading is scrolled away: start in the visible part of the form.
    const from = { x: start.x, y: scroller().getBoundingClientRect().top + 200 };
    await touchDrag(from, { x: from.x + 100, y: from.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);

    const details = wrapperOf("details");
    const port = scroller().getBoundingClientRect();
    const padTop = Number.parseFloat(getComputedStyle(scroller()).paddingTop);
    expect(details.hidden).toBe(false);
    expect(details.inert).toBe(true);
    expect(details.getBoundingClientRect().top).toBeCloseTo(port.top + padTop, 0);
    // A panel's width to the left of the form, moved with the finger.
    const rail = details.parentElement!;
    expect(details.style.transform).toBe(`translateX(${100 - rail.clientWidth}px)`);
    expect(getComputedStyle(rail).overflowX).toBe("clip");

    await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await settleSwipe();
    expect(getComputedStyle(rail).overflowX).not.toBe("clip");
  });

  it("eases a released panel to rest rather than snapping it", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 60, y: start.y }, { ms: 1000 });
    await new Promise(requestAnimationFrame);
    const transitions = moving(wrapperOf("details")).filter(
      (a) => (a as CSSTransition).transitionProperty === "transform",
    );
    expect(transitions).toHaveLength(1);
    await settleSwipe();
  });

  it("follows the first finger only, and settles cleanly when a second joins it", async () => {
    await openOn("details");
    const start = bodyOf("details");
    const session = cdp();
    const t0 = Date.now() / 1000;
    const one = (x: number) => toTop({ x, y: start.y });
    const two = toTop({ x: start.x, y: start.y + 120 });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...one(start.x), id: 1 }],
      timestamp: t0,
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...one(start.x - 80), id: 1 }],
      timestamp: t0 + 0.4,
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { ...one(start.x - 80), id: 1 },
        { ...two, id: 2 },
      ],
      timestamp: t0 + 0.5,
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { ...one(start.x - 90), id: 1 },
        { x: two.x - 200, y: two.y, id: 2 },
      ],
      timestamp: t0 + 0.9,
    });
    await new Promise(requestAnimationFrame);
    expect(wrapperOf("details").style.transform).toBe("translateX(-90px)");
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: t0 + 1,
    });
    await settleSwipe();

    // One panel on screen, nothing of the drag left on either.
    expect(wrapperOf("details").hidden).not.toBe(wrapperOf("rsvp").hidden);
    expect(wrapperOf("details").style.transform).toBe("");
    expect(wrapperOf("rsvp").style.transform).toBe("");
  });

  it("stands down while the guest has pinch-zoomed in, leaving the drag to pan the view", async () => {
    await openOn("details");
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "scale", { configurable: true, get: () => 2 });
    try {
      viewport.dispatchEvent(new Event("resize"));
      await new Promise(requestAnimationFrame);
      const rail = wrapperOf("details").parentElement!;
      // `touch-action: auto`, so the browser pans the zoomed view sideways.
      expect(getComputedStyle(rail).touchAction).toBe("auto");

      const start = bodyOf("details");
      await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
      await settleSwipe();
      expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
      // The badge still moves between the panels.
      await userEvent.click(button("Give RSVP"));
      expect(wrapperOf("rsvp").hidden).toBe(false);
    } finally {
      delete (viewport as unknown as { scale?: number }).scale;
      viewport.dispatchEvent(new Event("resize"));
      await settle();
    }
  });

  it("draws the form in beside the details under the finger, inert until it lands", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 120, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);

    const details = wrapperOf("details");
    const form = wrapperOf("rsvp");
    expect(details.style.transform).toBe("translateX(-120px)");
    expect(form.hidden).toBe(false);
    expect(form.inert).toBe(true);
    // A panel's width to the right of the details, so the two travel as one.
    const offset = form.getBoundingClientRect().left - details.getBoundingClientRect().left;
    expect(offset).toBeCloseTo(details.parentElement!.clientWidth, 0);

    await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await settleSwipe();
  });

  it("carries on to the form past a third of the way, with focus on its heading at the top", async () => {
    await openOn("details");
    scroller().scrollTop = 40;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    await settleSwipe();

    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);
    expect(document.activeElement?.textContent).toContain("Respond");
    expect(scroller().scrollTop).toBe(0);
    // Nothing of the swipe is left behind.
    expect(wrapperOf("rsvp").style.transform).toBe("");
    expect(wrapperOf("rsvp").inert).toBe(false);
    expect(wrapperOf("rsvp").className).not.toContain("absolute");
  });

  it("brings the details back with a swipe the other way", async () => {
    await openOn("rsvp");
    const start = bodyOf("rsvp");
    await touchDrag(start, { x: start.x + 250, y: start.y }, { ms: 600 });
    await settleSwipe();

    expect(wrapperOf("details").hidden).toBe(false);
    expect(wrapperOf("rsvp").hidden).toBe(true);
    expect(document.activeElement?.textContent).toContain("Details");
  });

  it("carries on after a quick flick that is short of a third", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 60, y: start.y }, { ms: 80, steps: 4 });
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
  });

  it("springs back from a short drag, and leaves no trace of it", async () => {
    // 20px: past the slop, so the drag begins, but under the shortest flick,
    // so it springs back however fast the browser says the finger moved.
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 20, y: start.y }, { ms: 1000 });
    await settleSwipe();

    expect(wrapperOf("details").hidden).toBe(false);
    expect(wrapperOf("details").style.transform).toBe("");
    expect(wrapperOf("rsvp").hidden).toBe(true);
    // A button switch afterwards still slides the form in.
    await userEvent.click(button("Give RSVP"));
    expect(wrapperOf("rsvp").className).toContain("animate-panel-from-end");
    await settle();
  });

  it("springs back when the finger rests before it lifts, however fast it moved", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 80, y: start.y }, { ms: 60, steps: 3, end: "hold" });
    // The finger stays still for a moment, then lifts. The lift carries no
    // timestamp of its own, so its time is the real one, well past the moves.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settleSwipe();
    expect(wrapperOf("details").hidden).toBe(false);
    expect(wrapperOf("rsvp").hidden).toBe(true);
  });

  it("springs back when the touch is cancelled mid-drag", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600, end: "cancel" });
    await settleSwipe();

    expect(wrapperOf("details").hidden).toBe(false);
    expect(wrapperOf("details").style.transform).toBe("");
    expect(wrapperOf("rsvp").hidden).toBe(true);
  });

  it("does nothing for a drag toward the side with no panel", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x + 120, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);
    expect(wrapperOf("details").style.transform).toBe("");
    expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
    await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  });

  it("leaves a vertical drag to the browser's scroll", async () => {
    await openOn("rsvp", party);
    const start = bodyOf("rsvp");
    await touchDrag({ x: start.x, y: start.y + 300 }, { x: start.x - 20, y: start.y }, { ms: 300 });
    await settleSwipe();
    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(dialog().querySelector('[data-panel="details"]')).toBeNull();
  });

  it("ignores a mouse drag, which is text selection on a desktop", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await mouseDrag(start, { x: start.x - 250, y: start.y });
    await settleSwipe();
    expect(wrapperOf("details").hidden).toBe(false);
    expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
  });

  it("leaves a drag on the dietary chips to their own sideways scroll", async () => {
    await openOn("rsvp");
    await userEvent.click(within(dialog()).getByText("Attending"));
    await settle();
    const track = [...dialog().querySelectorAll<HTMLElement>("*")].find(
      (el) => getComputedStyle(el).overflowX === "auto" && el.scrollWidth > el.clientWidth,
    );
    expect(track, "a sideways-scrolling dietary track at phone width").toBeTruthy();
    const r = track!.getBoundingClientRect();
    const start = { x: r.left + 30, y: r.top + r.height / 2 };
    await touchDrag(start, { x: start.x + 200, y: start.y }, { ms: 300 });
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(dialog().querySelector('[data-panel="details"]')).toBeNull();
  });

  it("does not leave the form while a reply is saving", async () => {
    let release!: () => void;
    const original = window.fetch;
    window.fetch = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
      });
    try {
      await openOn("rsvp");
      await userEvent.click(within(dialog()).getByText("Attending"));
      await userEvent.click(button("Save"));
      expect(button("See details").disabled).toBe(true);

      const start = bodyOf("rsvp");
      await touchDrag(start, { x: start.x + 250, y: start.y }, { ms: 600 });
      await settleSwipe();
      expect(wrapperOf("rsvp").hidden).toBe(false);
      expect(dialog().querySelector('[data-panel="details"]')).toBeNull();
    } finally {
      release?.();
      window.fetch = original;
      await settle();
    }
  });

  it("offers no swipe into the form past the deadline to a household with no reply", async () => {
    await page.viewport(...PHONE);
    render(() => (
      <EventSheet
        event={event}
        panel="details"
        siteUrl="https://invite.test/w"
        members={[priya]}
        apiUrl="https://api.test"
        closed
        onClose={() => {}}
      />
    ));
    await settle();
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    await settleSwipe();
    expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
    expect(wrapperOf("details").style.transform).toBe("");
  });

  it("settles at once under reduced motion", async () => {
    await emulate({ reducedMotion: "reduce" });
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    // No wait for a 280ms transition: two frames and the switch has happened.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);
  });
});

// ── One height ──────────────────────────────────────────────────────────

/** The least an event can carry: a name and a time, and a household of one. */
const sparse: EventSummary = {
  ...event,
  id: "event-sparse",
  name: "Tea",
  description: "",
  address: null,
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
};

/** Every row and section the details can show, and a party that scrolls. */
const full: EventSummary = {
  ...event,
  id: "event-full",
  name: "Sangeet",
  description:
    "An evening of music and dance with both families. The band starts at seven; " +
    "dinner is served from eight, and the dance floor stays open until late.\n\n" +
    "Parking is on the street and in the school car park opposite. The hall has " +
    "step-free access from the side entrance on Banksia Lane.",
  endAt: "2026-09-19T01:00:00+10:00",
  address: "Strathfield Town Hall, 65 Homebush Road, Strathfield NSW 2135",
  mapsUrl: "https://maps.google.com/?q=Strathfield+Town+Hall",
  dressCodeDescription: "Jewel tones — emerald, sapphire, ruby. Comfortable shoes for dancing.",
  dressCodePalette: [
    { name: "Emerald", color: "#1f7a4d" },
    { name: "Sapphire", color: "#1f4e9c" },
    { name: "Ruby", color: "#9b1b30" },
    { name: "Gold", color: "#c9a227" },
    { name: "Plum", color: "#5e2a5c" },
    { name: "Ivory", color: "#f4efe1" },
  ],
  pinterestUrl: "https://www.pinterest.com/cireweddings/sangeet-moodboard/",
};

const fullParty: FamilyMember[] = [
  ...["Asha", "Ravi", "Meera", "Dev"].map((firstName, i) => ({
    guestId: `guest-full-${i}`,
    firstName,
    lastName: "Sharma",
    nickname: null,
    eventIds: ["event-full"],
  })),
  // Not invited to this one, so the details carry "Invited: …".
  { guestId: "guest-full-x", firstName: "Nani", lastName: "Sharma", nickname: null, eventIds: [] },
];

const fixtures = [
  { name: "sparse", event: sparse, members: [{ ...priya, eventIds: ["event-sparse"] }] },
  { name: "full", event: full, members: fullParty },
];

/**
 * The sheet's one height at each size: 70% of a phone's screen, and from `md`
 * 85% of the window up to 640px. At 1280×800 the 640px ceiling is the smaller
 * term, and at 1280×720 the window's 85% is.
 */
const viewports = [
  { name: "phone", size: [390, 844] as const, height: 0.7 * 844 },
  { name: "desktop", size: [1280, 800] as const, height: 640 },
  { name: "short-desktop", size: [1280, 720] as const, height: 0.85 * 720 },
];

/**
 * Every height the dialog takes, read on each frame until stopped, so a height
 * that changes for a few frames mid-switch is caught as well as one that stays
 * changed. The computed height is the layout's, so the sheet's own entry
 * transform (a scale) is not in it.
 */
function watchHeight() {
  const seen = new Set<number>();
  let on = true;
  const read = () => {
    if (!on) return;
    seen.add(Number.parseFloat(getComputedStyle(dialog()).height));
    requestAnimationFrame(read);
  };
  read();
  return () => {
    on = false;
    return [...seen];
  };
}

function shot(name: string) {
  return page.screenshot({
    path: `__screenshots__/EventSheet.browser.test.tsx/height-${name}.png`,
  });
}

/** Swipe the panel on screen toward the other one, and let it land. */
async function swipeFrom(panel: EventPanel) {
  const start = bodyOf(panel);
  const dx = panel === "details" ? -250 : 250;
  await touchDrag(start, { x: start.x + dx, y: start.y }, { ms: 600 });
  await settleSwipe();
  expect(wrapperOf(panel).hidden).toBe(true);
}

describe("EventSheet — one height for both panels", () => {
  for (const vp of viewports) {
    for (const fx of fixtures) {
      it(`keeps one height on a ${fx.name} event at ${vp.size.join("×")}, by badge and by swipe`, async () => {
        await page.viewport(vp.size[0], vp.size[1]);
        const heights: Record<string, number[]> = {};

        // Opened on the details: the badge there and back, then a swipe there
        // and back. The first switch is the badge's.
        const first = render(() => <Harness event={fx.event} members={fx.members} />);
        await userEvent.click(cardButton("Event Details"));
        await settle();
        let stop = watchHeight();
        const h3 = wrapperOf("details").querySelector("h3")!.getBoundingClientRect();
        const dl = wrapperOf("details").querySelector("dl")!.getBoundingClientRect();
        const headingGap = dl.top - h3.bottom;
        await shot(`${vp.name}-${fx.name}-details`);
        await userEvent.click(button("Give RSVP"));
        await settle();
        await shot(`${vp.name}-${fx.name}-rsvp`);
        await userEvent.click(button("See details"));
        await settle();
        await swipeFrom("details");
        await swipeFrom("rsvp");
        heights.fromDetails = stop();
        first.unmount();
        document.documentElement.style.overflow = "";

        // Opened on the form: answer, which grows the form, then a swipe to
        // the details as the first switch, and the badge back.
        render(() => <Harness event={fx.event} members={fx.members} />);
        await userEvent.click(cardButton("Respond"));
        await settle();
        stop = watchHeight();
        await userEvent.click(within(dialog()).getAllByText("Attending")[0]!);
        await settle();
        // Nothing of the details has loaded for the form's sake.
        expect(dialog().querySelector('[data-panel="details"]')).toBeNull();
        const bar = button("Save").parentElement as HTMLElement;
        const gap = scroller().getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom;
        await shot(`${vp.name}-${fx.name}-rsvp-attending`);
        await swipeFrom("rsvp");
        await userEvent.click(button("Give RSVP"));
        await settle();
        heights.fromForm = stop();

        // One height, from the first frame to the last, whichever panel opened.
        expect(heights.fromDetails).toHaveLength(1);
        expect(heights.fromForm).toEqual(heights.fromDetails);
        expect(Math.abs(heights.fromDetails[0]! - vp.height)).toBeLessThan(1);
        // The form's action bar sits on the sheet's bottom edge.
        expect(Math.abs(gap)).toBeLessThan(1);
        // The details are laid out as before: their header's 1.5rem under the
        // heading, with the heading's own margin collapsed into it. A details
        // wrapper made a flex column would add the two.
        const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        expect(headingGap).toBeCloseTo(1.5 * rem, 1);
      });
    }
  }
});

describe("EventSheet — a full event inside the sheet", () => {
  for (const vp of viewports) {
    it(`scrolls both panels to their ends cleanly at ${vp.size.join("×")}`, async () => {
      await page.viewport(vp.size[0], vp.size[1]);
      render(() => <Harness event={full} members={fullParty} />);
      await userEvent.click(cardButton("Event Details"));
      await settle();
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);

      // The details scroll, and at their foot the sheet's bottom padding is
      // still under the last line: the details carry it themselves, since the
      // scrollport gives its own up for the form's bar.
      expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight);
      scroller().scrollTop = scroller().scrollHeight;
      await new Promise(requestAnimationFrame);
      // Within a pixel: the sheet's height is fractional (70% of 844px), and
      // the scroll offset snaps.
      const last = wrapperOf("details").lastElementChild!.getBoundingClientRect();
      const foot = scroller().getBoundingClientRect().bottom - last.bottom;
      expect(Math.abs(foot - 2.5 * rem)).toBeLessThan(1);
      await shot(`${vp.name}-full-details-end`);

      // The form scrolls under its bar, and its last guest ends above it.
      await userEvent.click(button("Give RSVP"));
      await settle();
      expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight);
      scroller().scrollTop = scroller().scrollHeight;
      await new Promise(requestAnimationFrame);
      const guests = wrapperOf("rsvp").querySelectorAll("form > fieldset");
      const bar = button("Save").parentElement!.getBoundingClientRect();
      expect(guests[guests.length - 1]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        bar.top,
      );
      expect(Math.abs(scroller().getBoundingClientRect().bottom - bar.bottom)).toBeLessThan(1);
      await shot(`${vp.name}-full-rsvp-end`);
    });
  }
});

/** The form's action bar, found without the accessibility tree: mid-swipe the form is `inert`. */
function barOf(panel: HTMLElement): HTMLElement {
  const save = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Save");
  return save!.parentElement as HTMLElement;
}

describe("EventSheet — the form a swipe draws in", () => {
  const cases = [
    { from: "a short details panel at its top", event: sparse, scroll: 0 },
    { from: "a long details panel scrolled down", event: full, scroll: 200 },
  ];
  for (const c of cases) {
    it(`seats its action bar on the sheet's bottom edge mid-drag, from ${c.from}`, async () => {
      // A form shorter than the sheet still ends on its bottom edge, where it
      // will rest once it lands; drawn at its own height it would land and
      // then drop its bar to the edge.
      await page.viewport(390, 844);
      render(() => <Harness event={c.event} members={[{ ...priya, eventIds: [c.event.id] }]} />);
      await userEvent.click(cardButton("Event Details"));
      await settle();
      scroller().scrollTop = c.scroll;
      expect(scroller().scrollTop).toBe(c.scroll);
      const port = scroller().getBoundingClientRect();
      const range = scroller().scrollHeight;
      const from = { x: port.left + port.width / 2, y: port.top + port.height / 2 };

      await touchDrag(from, { x: from.x - 120, y: from.y }, { end: "hold" });
      await new Promise(requestAnimationFrame);
      const form = wrapperOf("rsvp");
      try {
        expect(form?.inert).toBe(true);
        expect(barOf(form).getBoundingClientRect().bottom).toBeCloseTo(port.bottom, 0);
        // And no further: the form ends on the edge rather than past it, where
        // the sticky bar would hide the overshoot but the sheet would gain
        // scroll room under the finger. The wrapper is not sticky, so its own
        // edge shows an overshoot the bar hides.
        expect(form.getBoundingClientRect().bottom).toBeCloseTo(port.bottom, 0);
        expect(scroller().scrollHeight).toBe(range);
      } finally {
        // Sprung back. Lifted even when an assertion above fails, or the next
        // test's touch would start as a second finger.
        await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await settleSwipe();
      }
      // Nothing of the drag is left on the form.
      expect(form.hidden).toBe(true);
      expect(form.style.minHeight).toBe("");

      // Carried on: nor once it has landed.
      await touchDrag(from, { x: from.x - 250, y: from.y }, { ms: 600 });
      await settleSwipe();
      expect(form.hidden).toBe(false);
      expect(form.style.minHeight).toBe("");
      expect(barOf(form).getBoundingClientRect().bottom).toBeCloseTo(
        scroller().getBoundingClientRect().bottom,
        0,
      );
    });
  }
});
