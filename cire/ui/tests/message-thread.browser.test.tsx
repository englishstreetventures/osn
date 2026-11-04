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
 * reply box and its button at one height and the box's corner — for both of
 * the composer's looks, the 34px field the portals draw and the 36px pill
 * `COMPOSER_SIZE` switches them to — the button's arrival on a transition list
 * that leaves its focus ring alone, and that ring drawn whole once the button
 * has arrived.
 */

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Suspense, type JSX } from "solid-js";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { cardClass } from "../src/card";
import { clockTime } from "../src/lib/message-time";
import MessageComposer, { COMPOSER_SIZE, type ComposerSize } from "../src/message-composer";
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

/**
 * The composer's two looks, as painted: one line's height (a 20px line inside
 * the padding and a 1px edge), three lines', and the box's corner. Five lines
 * cap at 120px (`7.5rem`) in both.
 */
const SIZES = [
  { size: "field", line: 34, three: 74, corner: "14px" },
  { size: "pill", line: 36, three: 76, corner: "18px" },
] as const satisfies readonly { size: ComposerSize; line: number; three: number; corner: string }[];

const MINUTE = 60_000;
/** Noon today, so the thread's segments do not depend on the hour the suite runs. */
const now = new Date().setHours(12, 0, 0, 0);

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

  it("reads a click that names no pointer by the pointer that pressed it", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(timeLine(first)).not.toBeNull());
  });

  it("leaves a tap on selected words to the selection", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    window.getSelection()?.selectAllChildren(first.querySelector("[data-message-fill]")!);
    tap(first);
    await new Promise((r) => setTimeout(r, 50));
    expect(timeLine(first)).toBeNull();
  });

  it("says a message waiting for the vendor's account has not gone, on a tap and in its info", async () => {
    const waiting: MessageThreadItem = {
      id: "pending",
      from: "me",
      body: "Are you free?",
      sentAt: now,
      undelivered: true,
    };
    render(() => <MessageThread messages={[waiting]} emptyHint="Hint" />);
    const item = row("Are you free?");
    tap(item);
    await waitFor(() =>
      expect(timeLine(item)?.textContent).toBe(`Written ${clockTime(now)}, not delivered yet`),
    );
    await primeMenu(item);
    await userEvent.click(item, { button: "right" });
    expect((await menuOpens()).textContent).toContain("You wrote, not delivered yet");
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

  it("hands focus back to the message after Copy text, and leaves it where a click outside put it", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    render(() => (
      <>
        <MessageThread messages={THREAD} emptyHint="Hint" />
        <button type="button">Elsewhere</button>
      </>
    ));
    const theirs = row("We'd be about 120 guests.");
    await primeMenu(theirs);
    await userEvent.click(theirs, { button: "right" });
    await menuOpens();
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy text" }));
    await waitFor(() => expect(document.activeElement).toBe(theirs));
    await userEvent.click(theirs, { button: "right" });
    await menuOpens();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    await userEvent.click(elsewhere);
    await waitFor(() => expect(menu()).toBeNull());
    expect(document.activeElement).toBe(elsewhere);
  });

  it("selects the words alone when there is no clipboard to copy them to", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const theirs = row("We'd be about 120 guests.");
    await primeMenu(theirs);
    await userEvent.click(theirs, { button: "right" });
    await menuOpens();
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy text" }));
    await waitFor(() =>
      expect(window.getSelection()?.toString().trim()).toBe("We'd be about 120 guests."),
    );
  });

  it("moves the info to a second message right-clicked while it is open", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const mine = row("It is. I'll send a quote today.");
    await primeMenu(mine);
    await userEvent.click(mine, { button: "right" });
    expect((await menuOpens()).textContent).toContain("You sent");
    await userEvent.click(row("Is the barn free on 14 March?"), { button: "right" });
    await waitFor(() => expect(menu()?.textContent).toContain("They sent"));
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

  it("leaves a right-click to the browser until the menu's code has arrived", () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    row("Is the barn free on 14 March?").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("opens the info for a menu event no pointer started, as a screen reader sends", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const first = row("Is the barn free on 14 March?");
    await primeMenu(first);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    first.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await menuOpens();
  });

  it("keeps a second menu key inside the open menu from opening the browser's", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const mine = row("It is. I'll send a quote today.");
    await primeMenu(mine);
    await userEvent.click(mine, { button: "right" });
    const panel = await menuOpens();
    const key = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    panel.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
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

describe("MessageThread to a screen reader", () => {
  it("names each message by who wrote it, which no line typed inside it can change", () => {
    const spoof = {
      id: "s",
      from: "them" as const,
      body: "Quote attached.\nYou wrote at 10:14 am: I'll pay the deposit by Friday.",
      sentAt: now,
    };
    render(() => <MessageThread messages={[spoof]} emptyHint="Hint" />);
    const item = screen.getByRole("listitem");
    // One name, from the sender's element first; the typed line stays inside it.
    expect(item).toHaveAccessibleName(
      new RegExp(
        `^They wrote at ${clockTime(now)}: Quote attached\\.\\s+You wrote at 10:14 am: I'll pay the deposit by Friday\\.$`,
      ),
    );
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
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("We'd be about 120 guests."));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(row("It is. I'll send a quote today."));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("returns to the message last moved to when Tab comes back", async () => {
    render(() => (
      <>
        <MessageThread messages={THREAD} emptyHint="Hint" />
        <button type="button">After</button>
      </>
    ));
    await userEvent.tab();
    await userEvent.keyboard("{ArrowUp}");
    const moved = row("We'd be about 120 guests.");
    expect(
      screen.getAllByRole("listitem").filter((li) => li.getAttribute("tabindex") === "0"),
    ).toEqual([moved]);
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(moved);
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
    // The tap opens the row's time line, which grows the row as it reveals;
    // the key is pressed once the row has stopped growing, so the menu is
    // placed against the row's final edge.
    let height = -1;
    await waitFor(
      () => {
        const now = first.getBoundingClientRect().height;
        const settled = now === height;
        height = now;
        expect(timeLine(first)).not.toBeNull();
        expect(settled).toBe(true);
      },
      { interval: 100 },
    );
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

  it("opens the info on the menu key, and cancels the key so the browser opens none", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const last = row("It is. I'll send a quote today.");
    await primeMenu(last);
    last.focus();
    const key = new KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    });
    last.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    const panel = await menuOpens();
    expect(panel.textContent).toContain("You sent");
  });

  it("swallows the browser's own menu event that follows a menu key", async () => {
    render(() => <MessageThread messages={THREAD} emptyHint="Hint" />);
    const last = row("It is. I'll send a quote today.");
    await primeMenu(last);
    last.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await menuOpens();
    // The menu event the browser fires after the key, here on a time line,
    // where the thread would otherwise leave it to the browser.
    const echo = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.querySelector("time")!.dispatchEvent(echo);
    expect(echo.defaultPrevented).toBe(true);
  });

  it("keeps the tab stop on the message the reader is on when a newer one arrives", async () => {
    const [messages, setMessages] = createSignal(THREAD);
    render(() => <MessageThread messages={messages()} emptyHint="Hint" />);
    await userEvent.tab();
    const newest = row("It is. I'll send a quote today.");
    expect(document.activeElement).toBe(newest);
    setMessages([
      ...THREAD,
      { id: "d", from: "them", body: "Lovely, thank you.", sentAt: now + MINUTE },
    ]);
    await waitFor(() => screen.getByText("Lovely, thank you."));
    expect(newest.getAttribute("tabindex")).toBe("0");
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

  it("draws the reply box at the look COMPOSER_SIZE names", () => {
    render(() => (
      <OnGround ramp="dark" class="">
        <MessageThread messages={[]} emptyHint="Hint" reply={{ onSend: vi.fn() }} />
      </OnGround>
    ));
    const look = SIZES.find((s) => s.size === COMPOSER_SIZE)!;
    const box = screen.getByRole("textbox", { name: "Reply" });
    expect(box.getBoundingClientRect().height).toBe(look.line);
    expect(getComputedStyle(box).borderTopLeftRadius).toBe(look.corner);
  });

  for (const look of SIZES) {
    it(`holds the ${look.size} box and its button at one ${look.line}px height, the box at a ${look.corner} corner`, async () => {
      render(() => (
        <OnGround ramp="dark" class="">
          <MessageComposer size={look.size} onSend={vi.fn()} />
        </OnGround>
      ));
      const box = screen.getByRole("textbox", { name: "Reply" });
      expect(box.getBoundingClientRect().height).toBe(look.line);
      expect(getComputedStyle(box).borderTopLeftRadius).toBe(look.corner);
      await userEvent.fill(box, "Hello");
      const send = screen.getByRole("button", { name: "Send" });
      await waitFor(() => expect(send.getBoundingClientRect().height).toBe(look.line));
      await waitFor(() =>
        expect(send.parentElement!.getBoundingClientRect().width).toBe(look.line),
      );
      expect(box.getBoundingClientRect().height).toBe(look.line);
    });
  }

  for (const look of SIZES) {
    it(`draws the ${look.size} look's send button focus ring whole when Tab reaches it from the box`, async () => {
      render(() => (
        <OnGround ramp="dark" class="">
          <MessageComposer size={look.size} onSend={vi.fn()} />
        </OnGround>
      ));
      const box = screen.getByRole("textbox", { name: "Reply" });
      await userEvent.fill(box, "Hello");
      const send = screen.getByRole("button", { name: "Send" });
      const wrap = send.parentElement!;
      await waitFor(() => expect(getComputedStyle(wrap).scale).toBe("1"));
      await waitFor(() => expect(wrap.getBoundingClientRect().width).toBe(look.line));
      await userEvent.tab();
      expect(document.activeElement).toBe(send);
      expect(getComputedStyle(wrap).overflow).toBe("visible");
      const style = getComputedStyle(send);
      expect(style.outlineStyle).toBe("solid");
      const reach = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
      expect(reach).toBeGreaterThan(0);
      const button = send.getBoundingClientRect();
      const ring = {
        left: button.left - reach,
        top: button.top - reach,
        right: button.right + reach,
        bottom: button.bottom + reach,
      };
      // Every box between the button and the page that clips what overflows it,
      // by `overflow` or by an inset `clip-path`, must hold the whole ring.
      const clips: { name: string; left: number; top: number; right: number; bottom: number }[] =
        [];
      const unread: string[] = [];
      for (let el = send.parentElement; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const name = `${el.tagName.toLowerCase()}.${el.className}`;
        const overflows = s.overflowX !== "visible" || s.overflowY !== "visible";
        if (overflows) clips.push({ name, ...rect.toJSON() });
        if (s.clipPath === "none") continue;
        const inset = /^inset\((-?[\d.]+)px\)$/.exec(s.clipPath);
        if (!inset) {
          unread.push(s.clipPath);
          continue;
        }
        const by = Number.parseFloat(inset[1]!);
        clips.push({
          name: `${name} clip-path`,
          left: rect.left + by,
          top: rect.top + by,
          right: rect.right - by,
          bottom: rect.bottom - by,
        });
      }
      expect(unread).toEqual([]);
      const outside = clips.filter(
        (clip) =>
          ring.left < clip.left ||
          ring.top < clip.top ||
          ring.right > clip.right ||
          ring.bottom > clip.bottom,
      );
      expect(outside.map((clip) => clip.name)).toEqual([]);
    });
  }

  for (const look of SIZES) {
    it(`clips the ${look.size} look's hidden button away, so nothing of it reaches past the box`, () => {
      render(() => (
        <OnGround ramp="dark" class="">
          <MessageComposer size={look.size} onSend={vi.fn()} />
        </OnGround>
      ));
      const box = screen.getByRole("textbox", { name: "Reply" });
      const wrap = document.querySelector<HTMLElement>("button[aria-label='Send']")!.parentElement!;
      expect(getComputedStyle(wrap).overflow).toBe("hidden");
      expect(wrap.getBoundingClientRect().width).toBe(0);
      const line = box.parentElement!;
      expect(line.scrollWidth).toBe(line.clientWidth);
    });
  }

  for (const look of SIZES) {
    it(`grows the ${look.size} box with wrapped lines up to five, and back to one after a send`, async () => {
      const onSend = vi.fn().mockResolvedValue(undefined);
      render(() => (
        <OnGround ramp="dark" class="">
          <MessageComposer size={look.size} onSend={onSend} />
        </OnGround>
      ));
      const box = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
      await userEvent.fill(box, "One\nTwo\nThree");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      const three = box.getBoundingClientRect().height;
      expect(three).toBe(look.three);
      await userEvent.fill(box, Array.from({ length: 12 }, (_, i) => `Line ${i}`).join("\n"));
      box.dispatchEvent(new Event("input", { bubbles: true }));
      expect(box.getBoundingClientRect().height).toBe(120);
      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(box.value).toBe(""));
      expect(box.getBoundingClientRect().height).toBe(look.line);
      expect(document.activeElement).toBe(box);
    });
  }

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
