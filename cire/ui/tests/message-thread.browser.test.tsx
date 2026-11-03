/**
 * `MessageThread` in Chromium, against cire's two ramps.
 *
 * Everything a reader does to a thread runs here, because it runs on real
 * events: a phone's tap shows a message's time and a mouse click does not; the
 * keyboard moves through the messages as one tab stop and opens a message's
 * info; a right-click opens it unless the words were already selected or the
 * pointer was a finger; the menu's lazy module never trips the boundary a
 * portal wraps its view in. Then what it paints: every word at 4.5:1 on the
 * two grounds a thread sits on (the host's bare page, the vendor's card), the
 * reply box and its button at one 34px height, and the button's arrival on a
 * transition list that leaves its focus ring alone.
 */

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Suspense, type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { cardClass } from "../src/card";
import { clockTime } from "../src/lib/message-time";
import MessageThread, { type MessageThreadItem } from "../src/message-thread";
import { inkRatio } from "./test-support/paint";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

/** The two grounds a thread sits on: the host's page, the vendor's card. */
const GROUNDS = [
  { name: "the page", class: "" },
  { name: "a card", class: cardClass() },
] as const;

const MINUTE = 60_000;
const now = Date.now();

const THREAD: MessageThreadItem[] = [
  { id: "a", from: "them", body: "Is the barn free on 14 March?", sentAt: now - 90 * MINUTE },
  { id: "b", from: "them", body: "We'd be about 120 guests.", sentAt: now - 89 * MINUTE },
  { id: "c", from: "me", body: "It is. I'll send a quote today.", sentAt: now - 10 * MINUTE },
];

function OnGround(props: { ramp: Ramp; class: string; children: JSX.Element }) {
  return (
    <div data-ramp={props.ramp === "light" ? "light" : undefined} class="bg-ui-ground p-4">
      <div class={`w-xl p-4 ${props.class}`}>{props.children}</div>
    </div>
  );
}

const row = (words: string) => {
  const found = screen.getByText(words).closest<HTMLElement>("li");
  if (!found) throw new Error(`no message holds "${words}"`);
  return found;
};

const timeLine = (item: HTMLElement) => item.querySelector("p[aria-hidden='true']");

/** A finger's tap: a touch `pointerdown`, then the click a tap produces. */
function tap(el: HTMLElement) {
  el.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", isPrimary: true }),
  );
  el.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
}

const menu = () => document.querySelector<HTMLElement>("[role='menu']");

async function menuOpens() {
  await waitFor(() => expect(menu()).not.toBeNull());
  return menu()!;
}

/** Waits for the menu's module, which the thread fetches once a pointer enters it. */
async function primeMenu(item: HTMLElement) {
  await userEvent.hover(item);
  await new Promise((r) => setTimeout(r, 50));
}

describe("MessageThread under a pointer and a finger", () => {
  it("shows a message's time on a tap, moves it on a tap elsewhere, and hides it on a second", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    const last = row("It is. I'll send a quote today.");
    tap(first);
    await waitFor(() =>
      expect(timeLine(first)?.textContent).toBe(`Sent ${clockTime(THREAD[0]!.sentAt)}`),
    );
    tap(last);
    await waitFor(() => expect(timeLine(last)).not.toBeNull());
    expect(timeLine(first)).toBeNull();
    tap(last);
    await waitFor(() => expect(timeLine(last)).toBeNull());
  });

  it("shows nothing for a mouse click", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    await userEvent.click(first);
    await new Promise((r) => setTimeout(r, 50));
    expect(timeLine(first)).toBeNull();
  });

  it("opens a message's info on a right-click on its words, twice running", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const mine = row("It is. I'll send a quote today.");
    await primeMenu(mine);
    for (let round = 0; round < 2; round++) {
      await userEvent.click(screen.getByText("It is. I'll send a quote today."), {
        button: "right",
      });
      const panel = await menuOpens();
      expect(panel.getAttribute("aria-label")).toBe("Message info");
      expect(panel.textContent).toContain("You sent");
      expect(panel.textContent).toContain(clockTime(THREAD[2]!.sentAt));
      expect(screen.getByRole("menuitem", { name: "Copy text" })).toBeTruthy();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(menu()).toBeNull());
      expect(document.activeElement).toBe(mine);
    }
  });

  it("copies the words, and selects them when the clipboard refuses", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const theirs = row("We'd be about 120 guests.");
    await primeMenu(theirs);
    await userEvent.click(theirs, { button: "right" });
    await menuOpens();
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy text" }));
    expect(writeText).toHaveBeenCalledWith("We'd be about 120 guests.");

    writeText.mockRejectedValue(new Error("denied"));
    await userEvent.click(theirs, { button: "right" });
    await menuOpens();
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy text" }));
    await waitFor(() => expect(window.getSelection()?.toString()).toContain("120 guests"));
  });

  it("leaves a right-click on words already selected to the browser", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    await primeMenu(first);
    window.getSelection()?.selectAllChildren(first.querySelector("[data-message-fill]")!);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    first.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 2 }),
    );
    first.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(menu()).toBeNull();
  });

  it("leaves a right-click on a time line to the browser", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    await primeMenu(row("Is the barn free on 14 March?"));
    const divider = document.querySelector("time")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    divider.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("never opens the info for a finger, however long it is held", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    await primeMenu(first);
    first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    await new Promise((r) => setTimeout(r, 800));
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    first.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("opens the info without the portal's boundary showing its fallback, even for a tick", async () => {
    let fallbacks = 0;
    /** Counts each time the boundary falls back: a flash of one frame is still one. */
    function PanelLoading() {
      fallbacks += 1;
      return <p>Panel loading</p>;
    }
    render(() => (
      <Suspense fallback={<PanelLoading />}>
        <MessageThread messages={THREAD} emptyHint="Hint" />
      </Suspense>
    ));
    const mine = row("It is. I'll send a quote today.");
    await primeMenu(mine);
    await userEvent.click(mine, { button: "right" });
    await menuOpens();
    expect(fallbacks).toBe(0);
  });
});

describe("MessageThread from the keyboard", () => {
  it("is one tab stop, moved by the arrows, Home and End", async () => {
    render(() => (
      <>
        <MessageThread messages={THREAD} emptyHint="Hint" />
        <button type="button">After</button>
      </>
    ));
    await userEvent.tab();
    expect(document.activeElement).toBe(row("It is. I'll send a quote today."));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(row("We'd be about 120 guests."));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(row("Is the barn free on 14 March?"));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(row("It is. I'll send a quote today."));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("shows the time on Enter and Space, and hides it on Escape", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    await userEvent.tab();
    const last = row("It is. I'll send a quote today.");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(timeLine(last)).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(timeLine(last)).toBeNull());
    await userEvent.keyboard(" ");
    await waitFor(() => expect(timeLine(last)).not.toBeNull());
    await userEvent.keyboard(" ");
    await waitFor(() => expect(timeLine(last)).toBeNull());
  });

  it("opens the info on Shift+F10 at the message, after a touch as well", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    tap(first);
    first.focus();
    await new Promise((r) => setTimeout(r, 50));
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    const panel = await menuOpens();
    expect(panel.textContent).toContain("They sent");
    const box = first.getBoundingClientRect();
    const placed = panel.getBoundingClientRect();
    expect(Math.abs(placed.left - box.left)).toBeLessThan(12);
    expect(placed.top).toBeGreaterThanOrEqual(box.bottom - 1);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("keeps focus on a message when another one arrives", async () => {
    const [messages, setMessages] = createSignal(THREAD);
    render(() => <MessageThread messages={messages()} emptyHint="Hint" />);
    await userEvent.tab();
    await userEvent.keyboard("{ArrowUp}");
    const focused = row("We'd be about 120 guests.");
    expect(document.activeElement).toBe(focused);
    setMessages([
      { id: "d", from: "them", body: "Lovely, thank you.", sentAt: now },
      ...THREAD.map((m) => ({ ...m })),
    ]);
    await waitFor(() => screen.getByText("Lovely, thank you."));
    expect(document.activeElement).toBe(focused);
  });
});

describe("MessageThread as painted", () => {
  for (const ramp of RAMPS) {
    for (const ground of GROUNDS) {
      it(`holds every word at 4.5:1 on ${ground.name}, ${ramp}`, async () => {
        render(() => (
          <OnGround ramp={ramp} class={ground.class}>
            <MessageThread messages={THREAD} emptyHint="Hint" />
          </OnGround>
        ));
        for (const fill of document.querySelectorAll<HTMLElement>("[data-message-fill]")) {
          expect(inkRatio(fill)).toBeGreaterThanOrEqual(4.5);
        }
        for (const time of document.querySelectorAll<HTMLElement>("time")) {
          expect(inkRatio(time.parentElement!)).toBeGreaterThanOrEqual(4.5);
        }
        tap(row("It is. I'll send a quote today."));
        const line = await waitFor(() => {
          const found = timeLine(row("It is. I'll send a quote today."));
          expect(found).not.toBeNull();
          return found as HTMLElement;
        });
        await waitFor(() =>
          expect(getComputedStyle(line.parentElement!.parentElement!).opacity).toBe("1"),
        );
        expect(inkRatio(line)).toBeGreaterThanOrEqual(4.5);
      });

      it(`holds the empty thread's lines at 4.5:1 on ${ground.name}, ${ramp}`, () => {
        render(() => (
          <OnGround ramp={ramp} class={ground.class}>
            <MessageThread messages={[]} emptyHint="Your reply will start the thread." />
          </OnGround>
        ));
        expect(inkRatio(screen.getByText("No messages yet"))).toBeGreaterThanOrEqual(4.5);
        expect(
          inkRatio(screen.getByText("Your reply will start the thread.")),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("draws their side inside a hairline and yours the same height", () => {
    render(() => (
      <OnGround ramp="dark" class="">
        <MessageThread
          messages={[
            { id: "x", from: "them", body: "One line", sentAt: now - MINUTE },
            { id: "y", from: "me", body: "One line too", sentAt: now },
          ]}
          emptyHint="Hint"
        />
      </OnGround>
    ));
    const fills = [...document.querySelectorAll<HTMLElement>("[data-message-fill]")];
    const [theirs, mine] = fills;
    expect(getComputedStyle(theirs!).borderTopWidth).toBe("1px");
    expect(getComputedStyle(theirs!).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(mine!.getBoundingClientRect().height).toBe(theirs!.getBoundingClientRect().height);
  });

  it("holds the reply box and its button at one 34px height", async () => {
    render(() => (
      <OnGround ramp="dark" class="">
        <MessageThread messages={[]} emptyHint="Hint" reply={{ onSend: vi.fn() }} />
      </OnGround>
    ));
    const box = screen.getByRole("textbox", { name: "Reply" });
    expect(box.getBoundingClientRect().height).toBe(34);
    await userEvent.fill(box, "Hello");
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send.getBoundingClientRect().height).toBe(34));
    await waitFor(() => expect(send.parentElement!.getBoundingClientRect().width).toBe(34));
    expect(box.getBoundingClientRect().height).toBe(34);
  });

  it("brings the button in on width, margin, scale and opacity alone, on durations above zero", () => {
    render(() => <MessageThread messages={[]} emptyHint="Hint" reply={{ onSend: vi.fn() }} />);
    const wrap = document.querySelector<HTMLElement>("button[aria-label='Send']")!.parentElement!;
    const style = getComputedStyle(wrap);
    expect(style.transitionProperty).toBe("width, margin-left, scale, opacity");
    for (const duration of style.transitionDuration.split(",")) {
      expect(Number.parseFloat(duration)).toBeGreaterThan(0);
    }
  });
});
