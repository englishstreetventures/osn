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
 * and under reduced motion it is instant.
 */
import { cleanup, render, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

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
function Harness(props: { members?: FamilyMember[] }) {
  const [sheet, setSheet] = createSignal<EventPanel | null>(null);
  return (
    <>
      <EventCard
        event={event}
        onRespond={() => setSheet("rsvp")}
        onDetails={() => setSheet("details")}
      />
      <Show when={sheet()} keyed>
        {(panel) => (
          <EventSheet
            event={event}
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
  document.body.style.overflow = "";
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

    await userEvent.click(button("RSVP for this event"));
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

    await userEvent.click(button("View event details"));
    expect(document.activeElement?.textContent).toMatch(/Details.*Mehndi/);
    await settle();
    expect(getComputedStyle(wrapperOf("rsvp")).display).toBe("none");
    expect(getComputedStyle(wrapperOf("details")).display).not.toBe("none");

    await userEvent.click(button("RSVP for this event"));
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
    await userEvent.click(button("RSVP for this event"));
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
    await userEvent.click(button("View event details"));
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

    await userEvent.click(button("View event details"));
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

    button("RSVP for this event").click();
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

    button("View event details").click();
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

  it("eases the sheet's height between two panels of different heights", async () => {
    // Without it the sheet's edge would jump to the new height in one frame.
    await page.viewport(1280, 900);
    render(() => <Harness />);
    await userEvent.click(cardButton("Respond"));
    await settle();
    const before = dialog().offsetHeight;

    button("View event details").click();
    const resize = dialog()
      .getAnimations()
      .find((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => "height" in k));
    expect(resize).toBeTruthy();
    const frames = (resize!.effect as KeyframeEffect).getKeyframes();
    expect(frames[0]!.height).toBe(`${before}px`);
    await settle();
    expect(frames.at(-1)!.height).toBe(`${dialog().offsetHeight}px`);
    expect(dialog().offsetHeight).not.toBe(before);
  });

  it("seats the form's action bar on the scrollport's edge after arriving from the details", async () => {
    // The sheet drops its bottom padding for the form and keeps it for the
    // details. Measured once the slide and the resize are over, because
    // `getBoundingClientRect` reports the box after its transform.
    await page.viewport(...PHONE);
    render(() => <Harness members={party} />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    await userEvent.click(button("RSVP for this event"));
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

    button("View event details").click();
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
    await userEvent.click(button("RSVP for this event"));
    await settle();
    const spinner = document.createElement("span");
    wrapperOf("details").append(spinner);
    spinner.animate([{ transform: "rotate(0)" }, { transform: "rotate(1turn)" }], {
      duration: 1000,
      iterations: Infinity,
    });

    button("View event details").click();
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
    // must not clear the state of the one now running. And the resize starts
    // from the height on screen at the second press, not from either panel's.
    await page.viewport(1280, 900);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    button("RSVP for this event").click();
    // Hold the first resize halfway, so the height on screen is neither
    // panel's own.
    const first = dialog()
      .getAnimations()
      .find((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => "height" in k))!;
    first.pause();
    first.currentTime = 140;
    const midway = dialog().offsetHeight;
    const [fromKeyframe, toKeyframe] = (first.effect as KeyframeEffect).getKeyframes();
    expect(`${midway}px`).not.toBe(fromKeyframe!.height);
    expect(`${midway}px`).not.toBe(toKeyframe!.height);
    button("View event details").click();
    const [slide] = wrapperOf("details").getAnimations();
    slide!.pause();
    slide!.currentTime = 0;
    await new Promise(requestAnimationFrame);

    expect(getComputedStyle(wrapperOf("details")).pointerEvents).toBe("none");
    const panels = scroller().firstElementChild as HTMLElement;
    expect(getComputedStyle(panels).overflowX).toBe("clip");
    const resize = dialog()
      .getAnimations()
      .find((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => "height" in k));
    expect((resize!.effect as KeyframeEffect).getKeyframes()[0]!.height).toBe(`${midway}px`);

    slide!.finish();
    await settle();
  });
});

describe("EventSheet — the switch buttons", () => {
  it("gives each a 44px target on a phone, and Add to Calendar the same height", async () => {
    // Both sit in rows a thumb has to hit; "View event details" is drawn as a
    // link, which would otherwise be only as tall as its line of text.
    await page.viewport(...PHONE);
    render(() => <Harness />);
    await userEvent.click(cardButton("Event Details"));
    await settle();

    expect(button("RSVP for this event").getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(button(/add to calendar/i).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    await userEvent.click(button("RSVP for this event"));
    await settle();
    expect(button("View event details").getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });
});
