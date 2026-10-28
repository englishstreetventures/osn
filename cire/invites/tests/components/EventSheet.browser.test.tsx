/**
 * The event sheet's switch between its two panels, in a real engine.
 *
 * `EventSheet.test.tsx` holds the state: what mounts, what is hidden, which
 * title is handed focus. None of what is below exists in jsdom — no
 * `<dialog>` modality, no layout to hide a panel from, no animation to slide
 * one in, no focus restore when the dialog closes, no reduced-motion clamp, no
 * sticky bar for the content to scroll under — and each is part of what the
 * issues asked for: the guest moves between the panels without the dialog
 * closing, focus lands on the new title and goes back to the opener on close,
 * nothing typed is lost, the move is animated, under reduced motion it is
 * instant, the sheet keeps one height, and its bar stays put, frosted, while
 * the panel scrolls under it.
 */
import { contrastRatio, PALETTE_PRESET_KEYS, WCAG_TEXT_MIN, WCAG_UI_MIN } from "@cire/theme";
import { cleanup, render, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { EventCard } from "../../src/components/EventCard";
import { EventSheet, type EventPanel } from "../../src/components/EventSheet";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
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

/** The sheet's bar: its title, the badge and the close button, first in the scrollport. */
function bar(): HTMLElement {
  return scroller().firstElementChild as HTMLElement;
}

/** The title on screen: the bar's heading for the panel shown, which names the dialog. */
function title(): HTMLElement {
  return document.getElementById(dialog().getAttribute("aria-labelledby")!)!;
}

function wrapperOf(panel: EventPanel): HTMLElement {
  return dialog().querySelector<HTMLElement>(`[data-panel="${panel}"]`)!;
}

/** The box both panels are laid out in, and the swipe moves them inside. */
function rail(): HTMLElement {
  return dialog().querySelector<HTMLElement>("[data-panel]")!.parentElement!;
}

function button(name: string | RegExp): HTMLButtonElement {
  return within(document.body).getByRole("button", { name }) as HTMLButtonElement;
}

/**
 * The badge in the sheet's bar, by the name it has on the panel on screen.
 * Scoped to the dialog: the harness's event card has buttons of its own.
 */
function badge(name: "Give RSVP" | "See details" | "View your RSVP"): HTMLButtonElement {
  return within(dialog()).getByRole("button", { name }) as HTMLButtonElement;
}

/**
 * The badge and its two labels, the details' and the form's, found without the
 * accessibility tree: one of the two is always `aria-hidden`.
 */
function badgeParts() {
  const chip = [...bar().querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") !== "Close",
  )!;
  const [details, rsvp] = [...chip.firstElementChild!.children] as HTMLElement[];
  return { chip, details: details!, rsvp: rsvp! };
}

/** An element's computed opacity, as a number. */
function opacityOf(el: Element): number {
  return Number(getComputedStyle(el).opacity);
}

/** A computed `transform`'s sideways offset, in px. */
function shiftOf(el: Element): number {
  return new DOMMatrix(getComputedStyle(el).transform).m41;
}

/** The part of `box` inside `frame`, left to right, as on screen through a clip. */
function shownIn(box: DOMRect, frame: DOMRect) {
  const left = Math.max(box.left, frame.left);
  return { left, width: Math.max(0, Math.min(box.right, frame.right) - left) };
}

/**
 * The punctuation in `el`'s words that starts a line instead of ending the
 * line of the character before it — a comma left alone on a line of its own,
 * say. Read off each character's own box. The `sr-only` words are left out:
 * they are clipped to nothing on screen.
 */
function strandedPunctuation(el: Element): string[] {
  const stranded: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(".sr-only")) continue;
    const text = node.textContent ?? "";
    const boxOf = (at: number) => {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range.getClientRects()[0];
    };
    for (let i = 1; i < text.length; i++) {
      if (!/[\p{Pd}\p{Pe}\p{Pf}\p{Po}]/u.test(text[i]!)) continue;
      const before = boxOf(i - 1);
      const mark = boxOf(i);
      if (!before || !mark || Math.abs(mark.top - before.top) > mark.height / 2) {
        stranded.push(`${text.slice(Math.max(0, i - 8), i)}|${text[i]}`);
      }
    }
  }
  return stranded;
}

/**
 * Colours painted one over another, as the 8-bit sRGB pixel the screen shows.
 * A canvas does the compositing, so a translucent layer is blended with what
 * is under it rather than measured as if it were opaque.
 */
function painted(...layers: string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** How opaque a CSS colour is, 0–255, read off the pixel it paints. */
function alphaOf(colour: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3] ?? 0;
}

/**
 * The pixel behind `el`'s words when the bar is over `content`: every fill
 * from the bar down to `el`'s own, over that content. Blurring a field of one
 * colour leaves it that colour, so the backdrop filter changes nothing here.
 */
function groundUnder(el: Element, content: string): string {
  const fills: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    fills.unshift(getComputedStyle(node).backgroundColor);
    if (node === bar()) break;
  }
  return painted(content, ...fills);
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

/** Wait for the badge's words, whose easing is a transition rather than an animation. */
async function settleBadge() {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 320));
}

/** `close` lands in a task after the Escape that caused it. */
const afterTheCloseEvent = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  cleanup();
  document.documentElement.style.overflow = "";
  document.documentElement.style.scrollbarGutter = "";
  await emulate({ reducedMotion: "no-preference" });
});

describe("EventSheet — moving between the panels", () => {
  it("goes from the details to the form and back inside one open dialog, losing nothing", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);

    await userEvent.click(cardButton("Event details"));
    await settle();
    const sheet = dialog();
    expect(sheet.matches(":modal")).toBe(true);

    await userEvent.click(badge("Give RSVP"));
    expect(document.activeElement?.textContent).toMatch(/Respond.*Mehndi/);
    expect(document.activeElement?.tagName).toBe("H2");
    expect(bar().contains(document.activeElement)).toBe(true);
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

    await userEvent.click(badge("See details"));
    expect(document.activeElement?.textContent).toMatch(/Details.*Mehndi/);
    await settle();
    expect(getComputedStyle(wrapperOf("rsvp")).display).toBe("none");
    expect(getComputedStyle(wrapperOf("details")).display).not.toBe("none");

    await userEvent.click(badge("Give RSVP"));
    await settle();
    const back = within(sheet).getByRole("group", { name: /priya sharma/i });
    expect(within(back).getByText("Attending").getAttribute("aria-pressed")).toBe("true");
    expect((within(back).getByPlaceholderText(/no onion/i) as HTMLInputElement).value).toBe(
      "no curry leaves",
    );
  });

  it("gives focus back to Event details when closed from the form it led to", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    const opener = cardButton("Event details");

    await userEvent.click(opener);
    await settle();
    await userEvent.click(badge("Give RSVP"));
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
    await userEvent.click(badge("See details"));
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

    await userEvent.click(badge("See details"));
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
    await userEvent.click(cardButton("Event details"));
    await settle();

    badge("Give RSVP").click();
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
    const panels = rail();
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

    badge("See details").click();
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
    await userEvent.click(cardButton("Event details"));
    await settle();

    await userEvent.click(badge("Give RSVP"));
    await settle();

    const actionBar = button("Save").parentElement as HTMLElement;
    const gap =
      scroller().getBoundingClientRect().bottom - actionBar.getBoundingClientRect().bottom;
    expect(Math.abs(gap)).toBeLessThan(1);
  });

  it("switches at once under reduced motion", async () => {
    await emulate({ reducedMotion: "reduce" });
    await page.viewport(1280, 900);
    render(() => <Harness />);
    await userEvent.click(cardButton("Respond"));
    await settle();

    badge("See details").click();
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
    await userEvent.click(cardButton("Event details"));
    await settle();
    await userEvent.click(badge("Give RSVP"));
    await settle();
    const spinner = document.createElement("span");
    wrapperOf("details").append(spinner);
    spinner.animate([{ transform: "rotate(0)" }, { transform: "rotate(1turn)" }], {
      duration: 1000,
      iterations: Infinity,
    });

    badge("See details").click();
    const [slide] = wrapperOf("details").getAnimations();
    slide!.finish();
    await settle();

    expect(getComputedStyle(wrapperOf("details")).pointerEvents).toBe("auto");
    const panels = rail();
    expect(getComputedStyle(panels).overflowX).toBe("visible");
  });

  it("keeps a quick switch back mid-slide from lifting the new slide's limits early", async () => {
    // Switching back hides the panel still arriving, which cancels its slide
    // and settles it at once. That settle belongs to the earlier switch and
    // must not clear the state of the one now running.
    await page.viewport(1280, 900);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event details"));
    await settle();

    badge("Give RSVP").click();
    // Hold the first slide halfway, so the switch back lands mid-slide.
    const [first] = wrapperOf("rsvp").getAnimations();
    first!.pause();
    first!.currentTime = 140;
    badge("See details").click();
    const [slide] = wrapperOf("details").getAnimations();
    slide!.pause();
    slide!.currentTime = 0;
    await new Promise(requestAnimationFrame);

    expect(getComputedStyle(wrapperOf("details")).pointerEvents).toBe("none");
    const panels = rail();
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
    await userEvent.click(cardButton("Event details"));
    await settle();

    const close = button("Close").getBoundingClientRect();
    const give = badge("Give RSVP").getBoundingClientRect();
    expect(give.height).toBeGreaterThanOrEqual(44);
    expect(give.top + give.height / 2).toBeCloseTo(close.top + close.height / 2, 0);
    expect(give.right).toBeLessThanOrEqual(close.left);
    expect(button(/add to calendar/i).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    await userEvent.click(badge("Give RSVP"));
    await settle();
    expect(badge("See details").getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  it("is a pill, filled like the close button beside it", async () => {
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event details"));
    await settle();
    const give = badge("Give RSVP");
    const radius = Number.parseFloat(getComputedStyle(give).borderTopLeftRadius);
    expect(radius).toBeGreaterThanOrEqual(give.getBoundingClientRect().height / 2);
    // Opaque, on a bar the content scrolls under: the bar is frosted, and the
    // badge's words need a surface of their own to hold 4.5:1 over whatever
    // passes beneath ("frosts the bar" below) — filled like the close button.
    expect(alphaOf(getComputedStyle(give).backgroundColor)).toBe(255);
    expect(getComputedStyle(give).backgroundColor).toBe(
      getComputedStyle(button("Close")).backgroundColor,
    );
  });

  it("brightens its hairline under a hovering pointer", async () => {
    // On a desktop the badge answers a pointer over it, as every bordered
    // control here does: its accent hairline goes from 40% to full strength.
    await openOn("details");
    const give = badge("Give RSVP");
    const atRest = getComputedStyle(give).borderTopColor;
    expect(alphaOf(atRest)).toBeLessThan(255);
    await userEvent.hover(give);
    // Past the base's 100ms colour transition.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hovered = getComputedStyle(give).borderTopColor;
    expect(hovered).not.toBe(atRest);
    expect(alphaOf(hovered)).toBe(255);
  });

  it("starts the content below the bar on a 320px phone", async () => {
    await page.viewport(320, 640);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event details"));
    await settle();
    const row = bar().getBoundingClientRect();
    const first = wrapperOf("details").querySelector("dl")!.getBoundingClientRect();
    expect(first.top).toBeGreaterThanOrEqual(row.bottom);
    // Nor does the bar run off either of the sheet's edges.
    const sheet = dialog().getBoundingClientRect();
    expect(row.left).toBeGreaterThanOrEqual(sheet.left);
    expect(row.right).toBeLessThanOrEqual(sheet.right);
  });

  it.each([
    ["a party taller than the sheet", party],
    // The shortest form there is: the first to move the sheet's edge if its
    // height ever followed its content again, when the second tap would meet
    // the backdrop and close the sheet.
    ["a household of one", [priya]],
  ])("does not take the second tap of a double tap straight back, for %s", async (_, members) => {
    // The badge sits in the same place on both panels, and the sheet keeps
    // one height, so the second tap of a double tap lands on it again, now
    // leading back to the details.
    await page.viewport(...PHONE);
    render(() => <Harness members={members} />);
    await userEvent.click(cardButton("Event details"));
    await settle();
    const at = centre(badge("Give RSVP"));
    await mouseClick(at);
    // A thumb's double tap: the second lands some 60ms after the first.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.elementFromPoint(at.x, at.y)?.closest("button")).toBe(badge("See details"));
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
    await userEvent.click(cardButton("Event details"));
    await settle();
    await userEvent.click(badge("Give RSVP"));
    await settle();
    await mouseClick({ x: 10, y: 10 });
    await afterTheCloseEvent();
    expect(document.querySelector("dialog")).toBeNull();
  });
});

/**
 * A name too long for one line of the bar on any phone, with a word longer
 * than the title's whole line beside the badge at 320px, which has to break
 * inside itself to show.
 */
const longName: EventSummary = {
  ...event,
  name: "Sangeet and Reception, Thiruvananthapuram",
};

describe("EventSheet — the bar", () => {
  afterEach(() => {
    applyPaletteToRoot(null);
    const root = document.documentElement;
    for (const name of Array.from(root.style)) {
      if (name.startsWith("--")) root.style.removeProperty(name);
    }
  });

  for (const [w, h] of [
    [390, 844],
    [320, 568],
  ] as const) {
    it(`stays put while the details scroll under it, at ${w}×${h}`, async () => {
      const shotOf = (name: string) =>
        page.screenshot({
          path: `__screenshots__/EventSheet.browser.test.tsx/bar-${w}x${h}-${name}.png`,
        });
      await page.viewport(w, h);
      render(() => <Harness event={full} members={fullParty} />);
      await userEvent.click(cardButton("Event details"));
      await settle();
      const atRest = bar().getBoundingClientRect();
      const facts = wrapperOf("details").querySelector("dl")!;
      // At rest the content starts under the bar, not beneath it.
      expect(facts.getBoundingClientRect().top).toBeGreaterThanOrEqual(atRest.bottom);
      await shotOf("details");

      scroller().scrollTop = 200;
      await new Promise(requestAnimationFrame);
      expect(scroller().scrollTop).toBe(200);
      // The bar has not moved, and the facts have gone up under it.
      expect(bar().getBoundingClientRect().toJSON()).toEqual(atRest.toJSON());
      const under = facts.getBoundingClientRect();
      expect(under.top).toBeLessThan(atRest.top);
      expect(under.bottom).toBeGreaterThan(atRest.bottom);
      // Painted over them: the bar answers a hit test where the two meet, and
      // the facts are still there beneath it.
      const at = { x: atRest.left + atRest.width / 2, y: atRest.top + atRest.height / 2 };
      const stack = document.elementsFromPoint(at.x, at.y);
      expect(bar().contains(stack[0]!)).toBe(true);
      expect(stack).toContain(facts);
      await shotOf("details-scrolled");

      await userEvent.click(badge("Give RSVP"));
      await settle();
      expect(bar().getBoundingClientRect().toJSON()).toEqual(atRest.toJSON());
      await shotOf("rsvp");
    });
  }

  describe.each(PALETTE_PRESET_KEYS)("on the %s scheme", (palettePreset) => {
    it("frosts the bar, and holds its words over the darkest and lightest content", async () => {
      applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });
      await page.viewport(390, 844);
      render(() => <Harness event={full} members={fullParty} />);
      await userEvent.click(cardButton("Event details"));
      await settle();
      const style = getComputedStyle(bar());
      // Frosted: what passes under it is blurred, and shows through a fill
      // that is neither clear nor opaque.
      expect(style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter")).toContain(
        "blur(",
      );
      const alpha = alphaOf(style.backgroundColor);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(255);

      // Whatever the guest scrolls under it — a black swatch, a white
      // photograph — the bar's words stay readable: the title on the frost,
      // the badge's words and the cross on fills of their own.
      const words = [
        { name: "title", el: title(), min: WCAG_TEXT_MIN },
        { name: "Give RSVP", el: badge("Give RSVP"), min: WCAG_TEXT_MIN },
        { name: "Close", el: button("Close"), min: WCAG_UI_MIN },
      ];
      for (const content of ["#000", "#fff"]) {
        for (const word of words) {
          const ground = groundUnder(word.el, content);
          const measured =
            contrastRatio(painted(ground, getComputedStyle(word.el).color), ground) ?? 0;
          expect({ word: word.name, content, ok: measured >= word.min, measured }).toMatchObject({
            word: word.name,
            content,
            ok: true,
          });
        }
      }

      // For review: the details passing under the frost on this scheme.
      scroller().scrollTop = 200;
      await new Promise(requestAnimationFrame);
      await page.screenshot({
        path: `__screenshots__/EventSheet.browser.test.tsx/bar-390x844-${palettePreset}-scrolled.png`,
      });
    });
  });

  /** The badge beside the title on each panel it reads differently on. */
  const variants = [
    { label: "Give RSVP", panel: "details", closed: false, shot: "details" },
    { label: "See details", panel: "rsvp", closed: false, shot: "rsvp" },
    { label: "View your RSVP", panel: "details", closed: true, shot: "closed" },
  ] as const;
  for (const [w, h] of [
    [390, 844],
    [320, 568],
  ] as const) {
    for (const named of [event, longName]) {
      for (const variant of variants) {
        it(`shows the whole of "${named.name}" beside ${variant.label} at ${w}×${h}, the badge and the cross inside the bar`, async () => {
          await page.viewport(w, h);
          render(() => (
            <EventSheet
              event={named}
              panel={variant.panel}
              siteUrl="https://invite.test/w"
              members={[priya]}
              apiUrl="https://api.test"
              closed={variant.closed}
              replied
              onClose={() => {}}
            />
          ));
          await settle();
          const row = bar().getBoundingClientRect();
          const heading = title().getBoundingClientRect();
          const chip = badge(variant.label);
          const pill = chip.getBoundingClientRect();
          const close = button("Close").getBoundingClientRect();

          // In a row, inside the bar, none over another.
          expect(heading.left).toBeGreaterThanOrEqual(row.left);
          expect(heading.right).toBeLessThanOrEqual(pill.left + 0.5);
          expect(pill.right).toBeLessThanOrEqual(close.left + 0.5);
          expect(close.right).toBeLessThanOrEqual(row.right + 0.5);
          for (const box of [heading, pill, close]) {
            expect(box.top).toBeGreaterThanOrEqual(row.top);
            expect(box.bottom).toBeLessThanOrEqual(row.bottom);
          }
          // The badge and the cross never give way: the badge shows its whole
          // words at its full 44px, and the cross keeps its 44px target.
          expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
          expect(pill.height).toBeGreaterThanOrEqual(44);
          expect(close.width).toBeGreaterThanOrEqual(44);
          expect(close.height).toBeGreaterThanOrEqual(44);
          // Nor does the title: the whole name, unclipped and with no
          // ellipsis, on as many lines as it takes, the bar growing with it.
          expect(title().scrollWidth).toBeLessThanOrEqual(title().clientWidth);
          expect(title().scrollHeight).toBeLessThanOrEqual(title().clientHeight);
          expect(getComputedStyle(title()).textOverflow).not.toBe("ellipsis");
          expect(getComputedStyle(title()).overflow).toBe("visible");
          // Broken where a reader expects: no comma or other closing mark
          // pushed onto a line of its own, away from the word it ends.
          expect(strandedPunctuation(title())).toEqual([]);
          // And whatever height that takes, focus scrolling keeps clear of it.
          expect(Number.parseFloat(getComputedStyle(scroller()).scrollPaddingTop)).toBeCloseTo(
            row.height,
            1,
          );
          const slug = named === longName ? "long" : "short";
          await page.screenshot({
            path: `__screenshots__/EventSheet.browser.test.tsx/bar-${w}x${h}-${slug}-${variant.shot}.png`,
          });
        });
      }
    }
  }

  it("wraps a long name onto more lines at 320px, and the bar grows to hold them", async () => {
    // The long name cannot fit one line beside the badge on a small phone, so
    // this is where the bar's 3.75rem floor gives way to the title's lines.
    await page.viewport(320, 568);
    render(() => (
      <EventSheet
        event={longName}
        panel="details"
        siteUrl="https://invite.test/w"
        members={[priya]}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));
    await settle();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const line = Number.parseFloat(getComputedStyle(title()).lineHeight);
    expect(title().getBoundingClientRect().height).toBeGreaterThan(1.5 * line);
    expect(bar().getBoundingClientRect().height).toBeGreaterThan(3.75 * rem + 1);
    // The details still start one gap under it, wherever its foot now is.
    const facts = wrapperOf("details").querySelector("dl")!.getBoundingClientRect();
    expect(facts.top - bar().getBoundingClientRect().bottom).toBeCloseTo(1.25 * rem, 1);
  });

  it("steps the title down a type size on a phone narrower than 380px", async () => {
    // Where the badge leaves the title least room, a smaller face keeps most
    // names' words whole.
    await page.viewport(390, 844);
    render(() => (
      <EventSheet
        event={longName}
        panel="details"
        siteUrl="https://invite.test/w"
        members={[priya]}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));
    await settle();
    const wide = Number.parseFloat(getComputedStyle(title()).fontSize);
    await page.viewport(379, 844);
    await new Promise(requestAnimationFrame);
    const narrow = Number.parseFloat(getComputedStyle(title()).fontSize);
    expect(narrow).toBeLessThan(wide);
    // One step, not a different face: the same family and weight.
    expect(narrow / wide).toBeGreaterThan(0.75);
  });

  it("keeps a control reached by Shift+Tab clear of the bar, however tall a long name makes it", async () => {
    // Tabbing backwards up the form scrolls each control above the view to the
    // top of the scrollport. The scroll padding is what holds it below the
    // bar, and it follows the bar's height: here more than its 3.75rem floor.
    await page.viewport(320, 568);
    render(() => (
      <EventSheet
        event={longName}
        panel="rsvp"
        siteUrl="https://invite.test/w"
        members={party}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));
    await settle();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    expect(bar().getBoundingClientRect().height).toBeGreaterThan(3.75 * rem + 1);
    const port = scroller();
    port.scrollTop = port.scrollHeight;
    await new Promise(requestAnimationFrame);
    const save = button("Save");
    const actionBar = save.parentElement!;
    save.focus();

    // Every control on the way up, not only the last. One fully above the
    // view is scrolled to the middle whatever the padding; one partly under
    // the bar is still inside the scrollport, and only the scroll padding
    // moves it out from under the bar.
    const under: string[] = [];
    let above = false;
    for (let i = 0; i < 80 && !above; i++) {
      const before = port.scrollTop;
      await userEvent.tab({ shift: true });
      // A control above the view: reaching it scrolled the form back up.
      above = port.scrollTop < before;
      const focused = document.activeElement as HTMLElement;
      if (!focused.closest("[data-panel]") || actionBar.contains(focused)) continue;
      const gap = focused.getBoundingClientRect().top - bar().getBoundingClientRect().bottom;
      if (gap < -0.5) under.push(`${i}: ${focused.textContent} ${gap.toFixed(1)}px`);
    }
    expect(above, "Shift+Tab reached a control above the view").toBe(true);
    expect(under).toEqual([]);
    await page.screenshot({
      path: "__screenshots__/EventSheet.browser.test.tsx/bar-320x568-long-shift-tab.png",
    });
  });

  it("starts the details' facts 1.5rem under the closed notice past the deadline", async () => {
    // While RSVPs are open the notice's live region is empty and takes no
    // room ("keeps one height" measures the facts one gap under the bar).
    await page.viewport(...PHONE);
    render(() => (
      <EventSheet
        event={event}
        panel="details"
        siteUrl="https://invite.test/w"
        members={[priya]}
        apiUrl="https://api.test"
        closed
        replied
        onClose={() => {}}
      />
    ));
    await settle();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const notice = within(dialog()).getByRole("status").getBoundingClientRect();
    const facts = wrapperOf("details").querySelector("dl")!.getBoundingClientRect();
    expect(notice.top).toBeGreaterThanOrEqual(bar().getBoundingClientRect().bottom);
    expect(facts.top - notice.bottom).toBeCloseTo(1.5 * rem, 1);
  });

  it("names neither panel inside it: the badge and the bar's title say which is on screen", async () => {
    await openOn("details");
    await userEvent.click(badge("Give RSVP"));
    await settle();
    for (const panel of ["details", "rsvp"] as const) {
      expect(wrapperOf(panel).textContent).not.toMatch(/\b(Details|Respond|Your RSVP)\b/);
    }
    // The bar's title shows the event's name alone; the panel's name is for
    // the ear, clipped to nothing on screen.
    const spoken = title().querySelector(".sr-only")!;
    expect(spoken.textContent).toBe("Respond,");
    expect(spoken.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(title().textContent).toBe("Respond, Mehndi");
  });
});

describe("EventSheet — the badge follows a swipe", () => {
  it("is drawn at 390px on the details, mid-swipe and on the form", async () => {
    // Screenshots for review: "Give RSVP →" at rest, its words moving out by
    // the start as "← See details" comes in from the end under the finger,
    // and "← See details" once the form has landed.
    const shotOf = (name: string) =>
      page.screenshot({ path: `__screenshots__/EventSheet.browser.test.tsx/badge-${name}.png` });
    await page.viewport(390, 844);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event details"));
    await settle();
    await shotOf("details");

    const start = bodyOf("details");
    const width = rail().clientWidth;
    await touchDrag(start, { x: start.x - width * 0.45, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);
    const { details, rsvp } = badgeParts();
    try {
      expect(opacityOf(details)).toBeGreaterThan(0.3);
      expect(opacityOf(details)).toBeLessThan(0.7);
      expect(opacityOf(rsvp)).toBeGreaterThan(0.3);
      expect(opacityOf(rsvp)).toBeLessThan(0.7);
      await shotOf("mid-drag");
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settleSwipe();
    }

    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(opacityOf(details)).toBe(0);
    expect(opacityOf(rsvp)).toBe(1);
    await shotOf("rsvp");
  });

  it.each([20, 60])(
    "moves its words through the badge with a finger held %ipx in, side by side, with no easing, and back on a cancel",
    async (dx) => {
      await openOn("details");
      const width = rail().clientWidth;
      const start = bodyOf("details");
      await touchDrag(start, { x: start.x - dx, y: start.y }, { end: "hold" });
      await new Promise(requestAnimationFrame);
      const { chip, details, rsvp } = badgeParts();
      // The share of the panels' width the finger has covered.
      const share = dx / width;
      // Each label is the window's full width, so it moves by its share of it.
      // Its box, which its own sideways move does not resize, unrounded.
      const span = details.getBoundingClientRect().width;
      try {
        // A ticker the way the panels go: the details' words out by the start,
        // the form's in from the end, each by the finger's share.
        expect(Math.abs(-shiftOf(details) / span - share)).toBeLessThan(0.05);
        expect(Math.abs(shiftOf(rsvp) / span - (1 - share))).toBeLessThan(0.05);
        // Through the badge's window: some of each shows, side by side, and
        // what shows of one never lies over what shows of the other.
        const frame = chip.firstElementChild!.getBoundingClientRect();
        const out = shownIn(details.getBoundingClientRect(), frame);
        const into = shownIn(rsvp.getBoundingClientRect(), frame);
        expect(out.width).toBeGreaterThan(0);
        expect(into.width).toBeGreaterThan(0);
        const overlap = Math.min(out.left + out.width, into.left + into.width) - into.left;
        expect(out.left).toBeLessThan(into.left);
        expect(overlap).toBeLessThanOrEqual(0.5);
        // And the window really clips: just outside it, where each label's box
        // runs on, neither label is there to be painted or hit (a clip cuts
        // both), so neither spills over the badge's padding, the title or ×.
        const mid = frame.top + frame.height / 2;
        expect(document.elementsFromPoint(frame.left - 1, mid)).not.toContain(details);
        expect(document.elementsFromPoint(frame.right + 1, mid)).not.toContain(rsvp);
        // Fading as they go, at the same share.
        expect(Math.abs(opacityOf(details) - (1 - share))).toBeLessThan(0.05);
        expect(Math.abs(opacityOf(rsvp) - share)).toBeLessThan(0.05);
        expect(chip.hasAttribute("data-dragging")).toBe(true);
        // Under the finger nothing eases, or the words would trail it.
        expect(getComputedStyle(details).transitionProperty).toBe("none");
        expect(getComputedStyle(rsvp).transitionProperty).toBe("none");
        // Its name is the details' until the form lands.
        expect(badge("Give RSVP")).toBe(chip);
      } finally {
        await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await settleSwipe();
      }

      expect(shiftOf(details)).toBeCloseTo(0, 1);
      expect(shiftOf(rsvp)).toBeCloseTo(span, 1);
      expect(opacityOf(details)).toBe(1);
      expect(opacityOf(rsvp)).toBe(0);
      expect(chip.hasAttribute("data-dragging")).toBe(false);
      expect(getComputedStyle(details).transitionProperty).toBe("opacity, transform");
    },
  );

  it("keeps one width on both panels, at rest and mid-drag", async () => {
    // Both words share one grid cell, so the badge is as wide as the wider of
    // them whichever shows, and nothing beside it moves as they cross over.
    await openOn("details");
    const { chip, details, rsvp } = badgeParts();
    const atRest = chip.offsetWidth;
    expect(chip.clientWidth).toBeGreaterThanOrEqual(
      Math.max(details.offsetWidth, rsvp.offsetWidth),
    );

    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 120, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);
    try {
      expect(chip.offsetWidth).toBe(atRest);
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await settleSwipe();
    }

    await userEvent.click(badge("Give RSVP"));
    await settleBadge();
    expect(badge("See details")).toBe(chip);
    expect(chip.offsetWidth).toBe(atRest);
  });

  it("lands the form's words when a swipe carries on, and the details' with the swipe home", async () => {
    await openOn("details");
    let start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    await settleSwipe();
    const { details, rsvp } = badgeParts();
    expect(opacityOf(details)).toBe(0);
    expect(opacityOf(rsvp)).toBe(1);
    expect(badge("See details")).toBeTruthy();

    start = bodyOf("rsvp");
    await touchDrag(start, { x: start.x + 250, y: start.y }, { ms: 600 });
    await settleSwipe();
    expect(opacityOf(details)).toBe(1);
    expect(opacityOf(rsvp)).toBe(0);
    expect(badge("Give RSVP")).toBeTruthy();
  });

  it("eases its words over on a press, as the panels slide", async () => {
    await openOn("details");
    const { details, rsvp } = badgeParts();
    // Each transition the words start, heard as it is created rather than read
    // while it runs: the window is the panels' `--dur-base`, and a slow runner
    // can spend all of it between the click and a read.
    const easing = new Set<string>();
    const heard = (event: TransitionEvent) => easing.add(event.propertyName);
    for (const label of [details, rsvp]) label.addEventListener("transitionrun", heard);
    await userEvent.click(badge("Give RSVP"));
    const deadline = performance.now() + 3000;
    while (!(easing.has("opacity") && easing.has("transform"))) {
      if (performance.now() > deadline) break;
      await new Promise(requestAnimationFrame);
    }
    for (const label of [details, rsvp]) label.removeEventListener("transitionrun", heard);
    // Crossing over, not swapped: both words ease their opacity and their place.
    expect([...easing]).toEqual(expect.arrayContaining(["opacity", "transform"]));
    await settleBadge();
    expect(opacityOf(details)).toBe(0);
    expect(opacityOf(rsvp)).toBe(1);
  });

  it("opens on the form with the form's words already shown, not fading in", async () => {
    // Their place is written before the first paint, so a sheet opened on the
    // form shows no words moving as it opens.
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Respond"));
    const { details, rsvp } = badgeParts();
    expect(details.getAnimations()).toHaveLength(0);
    expect(rsvp.getAnimations()).toHaveLength(0);
    expect(opacityOf(details)).toBe(0);
    expect(opacityOf(rsvp)).toBe(1);
    expect(badge("See details")).toBeTruthy();
    await settle();
  });
});

/**
 * What the arriving title shows after a switch. The bar's title is never
 * reached by keyboard, so after a touch or a click the ring would read as the
 * title being selected. Chromium draws none either way; the engines that do
 * (iOS Safari) are out of reach here, so these pin the mechanism: the mark on
 * a pointer's or a swipe's move, none on a key's, and the rule that drops the
 * ring where the mark is.
 */
describe("EventSheet — focus after a switch", () => {
  it("hands the bar's title focus quietly after a swipe", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
    await settleSwipe();

    const heading = title();
    expect(heading.textContent).toMatch(/^Respond, /);
    expect(bar().contains(heading)).toBe(true);
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute("data-quiet-focus")).toBe(true);
    expect(getComputedStyle(heading).outlineStyle).toBe("none");
  });

  it("hands the bar's title focus quietly after a click on the badge", async () => {
    await openOn("details");
    await userEvent.click(badge("Give RSVP"));
    await settle();

    const heading = title();
    expect(heading.textContent).toMatch(/^Respond, /);
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute("data-quiet-focus")).toBe(true);
    expect(getComputedStyle(heading).outlineStyle).toBe("none");
  });

  it("keeps the ring for a key press on the badge, and drops it only where the mark is", async () => {
    await openOn("details");
    badge("Give RSVP").focus();
    await userEvent.keyboard("{Enter}");
    await settle();

    const heading = title();
    expect(heading.textContent).toMatch(/^Respond, /);
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute("data-quiet-focus")).toBe(false);
    // Reached by keyboard, so the engine draws the ring, and the page's rule
    // paints it — on a title that is on screen, in the bar.
    expect(heading.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(heading).outlineStyle).toBe("solid");
    expect(heading.checkVisibility()).toBe(true);
    const box = heading.getBoundingClientRect();
    const row = bar().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(row.top);
    expect(box.bottom).toBeLessThanOrEqual(row.bottom);

    // The same focus, marked: the rule in `global.css` takes the ring away.
    heading.setAttribute("data-quiet-focus", "");
    expect(getComputedStyle(heading).outlineStyle).toBe("none");
  });

  it("clears the mark once the title loses focus", async () => {
    await openOn("details");
    await userEvent.click(badge("Give RSVP"));
    await settle();
    const heading = title();
    expect(heading.hasAttribute("data-quiet-focus")).toBe(true);

    button("Close").focus();
    expect(heading.hasAttribute("data-quiet-focus")).toBe(false);
  });

  it("drops a text selection as a drag begins, and selects nothing while it runs", async () => {
    // A long press can start a native selection on the panel's text; the drag
    // that follows must not carry it along, highlighted, under the finger.
    await openOn("details");
    const day = wrapperOf("details").querySelector("dl p")!;
    getSelection()!.selectAllChildren(day);
    expect(getSelection()!.isCollapsed).toBe(false);

    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 120, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);
    try {
      expect(getSelection()!.isCollapsed).toBe(true);
      expect(getComputedStyle(rail()).userSelect).toBe("none");
      // No grey flash under the finger on iOS: the rail takes the pointer and
      // the title takes focus, and both are transparent to a tap.
      for (const el of [rail(), title()]) {
        expect(getComputedStyle(el).getPropertyValue("-webkit-tap-highlight-color")).toBe(
          "rgba(0, 0, 0, 0)",
        );
      }
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await settleSwipe();
    }
    // Once still, the text can be selected again (a long press to copy the address).
    expect(getComputedStyle(rail()).userSelect).not.toBe("none");
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

/** The last timestamp, in seconds, a touch helper has sent. */
let lastTouchStamp = 0;

/**
 * The time, in seconds, to stamp the next touch sequence with: now, or just
 * after the last stamp sent, whichever is later. `touchDrag` stamps its moves
 * over the speed it is asked for, which runs ahead of the clock, so a touch
 * sent straight after one would otherwise be stamped before it ended — and
 * Chromium drops a sequence whose time runs backwards, firing no click.
 */
function touchClock(): number {
  return Math.max(Date.now() / 1000, lastTouchStamp + 0.02);
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
  const t0 = touchClock();
  lastTouchStamp = t0 + ms / 1000 + 0.01;
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

/**
 * A point on the first line of a panel's content, across the middle of the
 * panel and clear of every control: the event's day on the details, the first
 * guest's name on the form. Never on the bar, which is no part of a panel and
 * starts no swipe.
 */
function bodyOf(panel: EventPanel): Point {
  const first = wrapperOf(panel).querySelector(panel === "details" ? "dl p" : "legend")!;
  const line = first.getBoundingClientRect();
  const across = wrapperOf(panel).getBoundingClientRect();
  return { x: across.left + across.width / 2, y: line.top + line.height / 2 };
}

/**
 * Wait for the swipe's settle. It is a scripted spring, which
 * `getAnimations()` cannot see, so this waits on the rail's `data-settling`,
 * which every settle carries until it lands — after a frame first, so a
 * release CDP has sent but the page has not yet handled is not missed.
 */
async function settleSwipe() {
  await new Promise(requestAnimationFrame);
  const deadline = performance.now() + 3000;
  while (rail().hasAttribute("data-settling")) {
    if (performance.now() > deadline) throw new Error("the swipe never settled");
    await new Promise(requestAnimationFrame);
  }
  await settle();
}

async function openOn(panel: EventPanel, members?: FamilyMember[]) {
  await page.viewport(...PHONE);
  render(() => <Harness members={members} />);
  await userEvent.click(cardButton(panel === "details" ? "Event details" : "Respond"));
  await settle();
}

/** The same, on the md sheet: 480px wide in a desktop viewport, still by touch. */
async function openOnWide(panel: EventPanel, members?: FamilyMember[]) {
  await page.viewport(1280, 800);
  render(() => <Harness members={members} />);
  await userEvent.click(cardButton(panel === "details" ? "Event details" : "Respond"));
  await settle();
}

/**
 * Every frame's offset of `el` from now until its settle lands, with the
 * frame's time — what the eye sees of a spring.
 */
async function framesOf(el: HTMLElement): Promise<{ t: number; x: number }[]> {
  const frames: { t: number; x: number }[] = [];
  await new Promise(requestAnimationFrame);
  const deadline = performance.now() + 3000;
  while (rail().hasAttribute("data-settling") && performance.now() < deadline) {
    const t = await new Promise<number>(requestAnimationFrame);
    frames.push({ t, x: el.style.transform === "" ? 0 : shiftOf(el) });
  }
  return frames;
}

/**
 * Lift a finger `touchDrag` left down (`end: "hold"`) after it has rested
 * `ms`, so it lifts with no speed. A fast lift starts the browser's own fling,
 * and Chromium spends the next tap on stopping that fling: it fires no click.
 * Headless Chromium on Linux flings where it does not on macOS.
 */
async function liftAfterRest(ms = 150) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  const t = Math.max(touchClock(), lastTouchStamp + ms / 1000);
  lastTouchStamp = t;
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
    timestamp: t,
  });
}

/** A finger that goes down at `at`, moves `jitter` px and lifts: a tap. */
async function tapAt(at: Point, jitter = 0) {
  const session = cdp();
  const p = toTop(at);
  const t0 = touchClock();
  lastTouchStamp = t0 + 0.05;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...p, id: 1 }],
    timestamp: t0,
  });
  if (jitter) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: p.x + jitter, y: p.y, id: 1 }],
      timestamp: t0 + 0.02,
    });
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
    timestamp: t0 + 0.05,
  });
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
    const form = wrapperOf("rsvp");
    // A replayed slide is heard as it starts, so one short enough to finish
    // before the read below is still caught.
    const replayed: string[] = [];
    const heard = (event: AnimationEvent) => {
      if (event.target === form) replayed.push(event.animationName);
    };
    form.addEventListener("animationstart", heard);
    await touchDrag(start, { x: start.x + 60, y: start.y }, { steps: 2, end: "hold" });
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    form.removeEventListener("animationstart", heard);
    expect(replayed).toEqual([]);
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
    const restTop = wrapperOf("rsvp").getBoundingClientRect().top;
    scroller().scrollTop = 200;
    const start = bodyOf("rsvp");
    // The heading is scrolled away: start in the visible part of the form.
    const from = { x: start.x, y: scroller().getBoundingClientRect().top + 200 };
    await touchDrag(from, { x: from.x + 100, y: from.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);

    const details = wrapperOf("details");
    expect(details.hidden).toBe(false);
    expect(details.inert).toBe(true);
    // Where the form starts at rest, under the bar, wherever the form is
    // scrolled: the place the details will be once they land.
    expect(details.getBoundingClientRect().top).toBeCloseTo(restTop, 0);
    // A panel's width to the left of the form, moved with the finger.
    expect(details.style.transform).toBe(`translateX(${100 - rail().clientWidth}px)`);
    expect(getComputedStyle(rail()).overflowX).toBe("clip");
    // Under the bar, which a swipe never moves.
    expect(details.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      bar().getBoundingClientRect().bottom,
    );

    await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await settleSwipe();
    expect(getComputedStyle(rail()).overflowX).not.toBe("clip");
  });

  it("springs a released panel to rest rather than snapping it", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - 60, y: start.y }, { ms: 1000 });
    const frames = await framesOf(wrapperOf("details"));
    // Several frames on the way, each nearer rest than the last, none past it.
    const between = frames.filter((f) => f.x < -1);
    expect(between.length).toBeGreaterThan(2);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.x).toBeGreaterThanOrEqual(frames[i - 1]!.x - 0.5);
      expect(frames[i]!.x).toBeLessThanOrEqual(0.5);
    }
    await settleSwipe();
    expect(wrapperOf("details").style.transform).toBe("");
  });

  it("follows the first finger only, and settles cleanly when a second joins it", async () => {
    await openOn("details");
    const start = bodyOf("details");
    const session = cdp();
    const t0 = touchClock();
    lastTouchStamp = t0 + 1;
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
      // `touch-action: auto`, so the browser pans the zoomed view sideways.
      expect(getComputedStyle(rail()).touchAction).toBe("auto");

      const start = bodyOf("details");
      await touchDrag(start, { x: start.x - 250, y: start.y }, { ms: 600 });
      await settleSwipe();
      expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
      // The badge still moves between the panels.
      await userEvent.click(badge("Give RSVP"));
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

  it("carries on to the form past a third of the way, with focus on its title at the top", async () => {
    await openOn("details");
    // Taken before the scroll, which carries the day up under the bar: a
    // touch there would be on the bar, which starts no swipe.
    const start = bodyOf("details");
    scroller().scrollTop = 40;
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
    await userEvent.click(badge("Give RSVP"));
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

  it("gives a little under a pull toward the side with no panel, and draws nothing in", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x + 80, y: start.y }, { end: "hold" });
    await new Promise(requestAnimationFrame);
    try {
      const pulled = shiftOf(wrapperOf("details"));
      expect(pulled).toBeGreaterThan(0);
      expect(pulled).toBeLessThan(80);
      // Nothing beside it to show, so nothing mounted: no map, no board.
      expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
      expect(getComputedStyle(rail()).overflowX).toBe("clip");
      expect(badgeParts().chip.style.getPropertyValue("--badge-progress")).toBe("0");

      // Back past where it started: the panel stops at its rest.
      const session = cdp();
      const back = toTop({ x: start.x - 40, y: start.y });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...back, id: 1 }],
      });
      await new Promise(requestAnimationFrame);
      expect(shiftOf(wrapperOf("details"))).toBe(0);
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settleSwipe();
    }
    expect(wrapperOf("details").style.transform).toBe("");
    expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
  });

  it("springs a pull toward the side with no panel back to rest", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x + 120, y: start.y }, { ms: 300 });
    const frames = await framesOf(wrapperOf("details"));
    expect(frames.filter((f) => f.x > 1).length).toBeGreaterThan(1);
    await settleSwipe();
    expect(wrapperOf("details").style.transform).toBe("");
    expect(wrapperOf("details").hidden).toBe(false);
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
      expect(badge("See details").disabled).toBe(true);

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
    // No wait for a spring: two frames and the switch has happened.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);
  });
});

describe("EventSheet — the swipe's physics", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("damps a drag past the form's rest, keeps the badge inside its rests, and springs in", async () => {
    await openOnWide("details");
    const width = rail().clientWidth;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - width - 120, y: start.y }, { ms: 800, end: "hold" });
    await new Promise(requestAnimationFrame);
    let held = 0;
    try {
      // The form is past its rest by less than the finger is.
      held = shiftOf(wrapperOf("rsvp"));
      expect(held).toBeLessThan(0);
      expect(held).toBeGreaterThan(-120);
      const progress = Number(badgeParts().chip.style.getPropertyValue("--badge-progress"));
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: "__screenshots__/EventSheet.browser.test.tsx/band-past-the-form.png",
      });
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    const frames = await framesOf(wrapperOf("rsvp"));
    // Springing in from beyond its rest, not snapping there.
    expect(frames.some((f) => f.x < -1 && f.x > held + 1)).toBe(true);
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);
  });

  it("carries a flick's speed into the settle", async () => {
    /** ms from the first spring frame until the form is 80% of the way in. */
    async function timeTo80(lift: "flick" | "rest") {
      await openOn("details");
      const width = rail().clientWidth;
      const start = bodyOf("details");
      const to = { x: start.x - width * 0.4, y: start.y };
      if (lift === "flick") {
        // ~0.4 × 366px in 40ms: over 3px/ms at the lift.
        await touchDrag(start, to, { ms: 40, steps: 8 });
      } else {
        await touchDrag(start, to, { ms: 300, end: "hold" });
        await sleep(150);
        await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      const frames = await framesOf(wrapperOf("rsvp"));
      await settleSwipe();
      expect(wrapperOf("rsvp").hidden).toBe(false);
      cleanup();
      const near = frames.find((f) => Math.abs(f.x) <= width * 0.6 * 0.2)!;
      return near.t - frames[0]!.t;
    }
    const flicked = await timeTo80("flick");
    const rested = await timeTo80("rest");
    // From the spring's formula: about 105ms against 143ms. At least a frame.
    expect(flicked + 16).toBeLessThanOrEqual(rested);
  });

  it("catches a settling panel without pressing what was under the finger", async () => {
    await openOn("details");
    const width = rail().clientWidth;
    const start = bodyOf("details");
    // A slow, short drag: it springs back.
    await touchDrag(start, { x: start.x - width * 0.2, y: start.y }, { ms: 600 });
    await sleep(60);
    expect(rail().hasAttribute("data-settling")).toBe(true);

    const target = within(wrapperOf("details")).getAllByRole("button")[0]!;
    let pressed = 0;
    const press = () => pressed++;
    target.addEventListener("click", press);
    const seen: MouseEvent[] = [];
    const watch = (e: MouseEvent) => seen.push(e);
    window.addEventListener("click", watch, true);
    try {
      // A real finger jitters: 2px is still a tap.
      await tapAt(centre(target), 2);
      await sleep(40);
      expect(pressed).toBe(0);
      // The tap did fire a click, and it reached the window already stopped.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.defaultPrevented).toBe(true);
    } finally {
      target.removeEventListener("click", press);
      window.removeEventListener("click", watch, true);
    }
    // The tap let go, so the settle went on to where it was going.
    await settleSwipe();
    expect(wrapperOf("details").style.transform).toBe("");
    expect(wrapperOf("details").hidden).toBe(false);
  });

  it("hands a caught panel to the finger, and the next tap after it lands", async () => {
    await openOn("details", party);
    const width = rail().clientWidth;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - width * 0.2, y: start.y }, { ms: 600 });
    await sleep(60);
    // Caught mid-settle and dragged on past the commit share.
    const at = { x: start.x - width * 0.1, y: start.y };
    await touchDrag(at, { x: at.x - width * 0.35, y: at.y }, { ms: 400 });
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);

    // Past the swallow's lapse, a tap on the form reaches its control.
    await sleep(350);
    const control = within(wrapperOf("rsvp")).getAllByRole("button")[0]!;
    let pressed = 0;
    const press = () => pressed++;
    control.addEventListener("click", press);
    try {
      await tapAt(centre(control));
      await sleep(40);
      expect(pressed).toBe(1);
    } finally {
      control.removeEventListener("click", press);
    }
  });

  it("swallows nothing after a catch that became a drag, so the next tap goes through", async () => {
    await openOn("details");
    const width = rail().clientWidth;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - width * 0.2, y: start.y }, { ms: 600 });
    await sleep(60);
    // Caught, then dragged back past where it began: the release springs out
    // of a rubber band, which no later touch can catch.
    const at = { x: start.x - width * 0.1, y: start.y };
    await touchDrag(at, { x: at.x + width * 0.4, y: at.y }, { ms: 200, end: "hold" });
    await liftAfterRest();
    // Captured at the window, ahead of the rail's own listener, and read after
    // dispatch: a swallowed click still arrives here, marked prevented.
    const seen: MouseEvent[] = [];
    const watch = (e: MouseEvent) => seen.push(e);
    window.addEventListener("click", watch, true);
    try {
      // Within 300ms of the lift, on the panel still springing back — so it
      // lands on whatever is under the finger then, which is beside the
      // point: a swallow timed alone would cancel it wherever it lands.
      await tapAt(bodyOf("details"));
      await sleep(40);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("click", watch, true);
    }
    await settleSwipe();
  });

  it("lets a committed swipe land when a scroll starts on it mid-settle", async () => {
    await openOn("details", party);
    const width = rail().clientWidth;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - width * 0.5, y: start.y }, { ms: 600 });
    await sleep(60);
    expect(rail().hasAttribute("data-settling")).toBe(true);
    const at = { x: start.x - width * 0.3, y: start.y + 150 };
    await touchDrag(at, { x: at.x, y: at.y - 200 }, { ms: 200 });
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("details").hidden).toBe(true);
  });

  it("holds a fast flick at the form's rest rather than past it", async () => {
    await openOn("details");
    const width = rail().clientWidth;
    const start = bodyOf("details");
    // Over 7px/ms at the lift, past ω × the distance left: a critically damped
    // spring from here would cross its target.
    await touchDrag(start, { x: start.x - width * 0.6, y: start.y }, { ms: 30, steps: 6 });
    const frames = await framesOf(wrapperOf("rsvp"));
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.x).toBeGreaterThanOrEqual(-0.5);
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
  });

  it("closed mid-settle, hands focus back to the card button that opened it", async () => {
    await openOn("details");
    const width = rail().clientWidth;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - width * 0.5, y: start.y }, { ms: 600 });
    expect(rail().hasAttribute("data-settling")).toBe(true);
    await userEvent.keyboard("{Escape}");
    const deadline = performance.now() + 3000;
    while (document.querySelector("dialog") && performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
    }
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(cardButton("Event details"));
  });

  it("lets a tap during a pull's spring back through, and does not catch it", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x + 120, y: start.y }, { ms: 300, end: "hold" });
    await liftAfterRest();
    expect(rail().hasAttribute("data-settling")).toBe(true);
    // Captured at the window, ahead of the rail's own listener, and read after
    // dispatch: a swallowed click still arrives here, marked prevented. The
    // panel is still moving, so the click lands on whatever is under the
    // finger then — not caught means it is not cancelled, wherever it lands.
    const seen: MouseEvent[] = [];
    const watch = (e: MouseEvent) => seen.push(e);
    window.addEventListener("click", watch, true);
    try {
      await tapAt(bodyOf("details"));
      await sleep(40);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("click", watch, true);
    }
    await settleSwipe();
    expect(wrapperOf("details").style.transform).toBe("");
  });

  it("ignores a tap on the badge while a pull springs back", async () => {
    await openOn("details");
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x + 120, y: start.y }, { ms: 300 });
    expect(rail().hasAttribute("data-settling")).toBe(true);
    await tapAt(centre(badge("Give RSVP")));
    await settleSwipe();
    await settle();
    expect(wrapperOf("details").hidden).toBe(false);
    expect(dialog().querySelector('[data-panel="rsvp"]')).toBeNull();
  });

  it("does not catch a swipe springing in from past the form's rest", async () => {
    await openOnWide("details");
    const width = rail().clientWidth;
    const start = bodyOf("details");
    await touchDrag(start, { x: start.x - width - 120, y: start.y }, { ms: 800 });
    expect(rail().hasAttribute("data-settling")).toBe(true);
    const seen: MouseEvent[] = [];
    const watch = (e: MouseEvent) => seen.push(e);
    window.addEventListener("click", watch, true);
    try {
      await tapAt(bodyOf("rsvp"));
      await sleep(40);
      // Not caught: the settle runs on, and the tap's click is not stopped.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((e) => !e.defaultPrevented)).toBe(true);
    } finally {
      window.removeEventListener("click", watch, true);
    }
    await settleSwipe();
    expect(wrapperOf("rsvp").hidden).toBe(false);
    expect(wrapperOf("rsvp").style.transform).toBe("");
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
        // and back. The first switch is a press of the badge.
        const first = render(() => <Harness event={fx.event} members={fx.members} />);
        await userEvent.click(cardButton("Event details"));
        await settle();
        let stop = watchHeight();
        const dl = wrapperOf("details").querySelector("dl")!.getBoundingClientRect();
        const underBar = dl.top - bar().getBoundingClientRect().bottom;
        await shot(`${vp.name}-${fx.name}-details`);
        await userEvent.click(badge("Give RSVP"));
        await settle();
        await shot(`${vp.name}-${fx.name}-rsvp`);
        await userEvent.click(badge("See details"));
        await settle();
        await swipeFrom("details");
        await swipeFrom("rsvp");
        heights.fromDetails = stop();
        first.unmount();
        document.documentElement.style.overflow = "";
        document.documentElement.style.scrollbarGutter = "";

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
        const actionBar = button("Save").parentElement as HTMLElement;
        const gap =
          scroller().getBoundingClientRect().bottom - actionBar.getBoundingClientRect().bottom;
        await shot(`${vp.name}-${fx.name}-rsvp-attending`);
        await swipeFrom("rsvp");
        await userEvent.click(badge("Give RSVP"));
        await settle();
        heights.fromForm = stop();

        // One height, from the first frame to the last, whichever panel opened.
        expect(heights.fromDetails).toHaveLength(1);
        expect(heights.fromForm).toEqual(heights.fromDetails);
        expect(Math.abs(heights.fromDetails[0]! - vp.height)).toBeLessThan(1);
        // The form's action bar sits on the sheet's bottom edge.
        expect(Math.abs(gap)).toBeLessThan(1);
        // The details start one 1.25rem gap under the bar, with nothing of
        // their empty header between: its live region is there from the
        // start, and takes no room while it says nothing.
        const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        expect(underBar).toBeCloseTo(1.25 * rem, 1);
      });
    }
  }
});

describe("EventSheet — a full event inside the sheet", () => {
  for (const vp of viewports) {
    it(`scrolls both panels to their ends cleanly at ${vp.size.join("×")}`, async () => {
      await page.viewport(vp.size[0], vp.size[1]);
      render(() => <Harness event={full} members={fullParty} />);
      await userEvent.click(cardButton("Event details"));
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
      await userEvent.click(badge("Give RSVP"));
      await settle();
      expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight);
      scroller().scrollTop = scroller().scrollHeight;
      await new Promise(requestAnimationFrame);
      const guests = wrapperOf("rsvp").querySelectorAll("form > fieldset");
      const actionBar = button("Save").parentElement!.getBoundingClientRect();
      expect(guests[guests.length - 1]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        actionBar.top,
      );
      expect(Math.abs(scroller().getBoundingClientRect().bottom - actionBar.bottom)).toBeLessThan(
        1,
      );
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
      await userEvent.click(cardButton("Event details"));
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
