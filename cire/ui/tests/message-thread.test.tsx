// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clockTime, dividerLabel } from "../src/lib/message-time";
import MessageThread, { type MessageThreadItem } from "../src/message-thread";

/**
 * What a portal relies on from the thread's markup: each side drawn its own
 * way, `data-mine` where the portals' tests look for it, who wrote each message
 * and when for anyone who cannot see the column, one line opening each
 * segment, the run spacing, the three states with no messages, and the reply
 * box's send rules. happy-dom computes no layout and fires no real pointer, so
 * every pointer, key and menu behaviour, and every painted colour, is held in
 * `message-thread.browser.test.tsx`.
 */

afterEach(cleanup);

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 14, 0, 0);

const msg = (over: Partial<MessageThreadItem> & { id: string }): MessageThreadItem => ({
  from: "them",
  body: `Body of ${over.id}`,
  sentAt: T0,
  ...over,
});

/** The element that draws a message's fill: the parent of the words' text. */
function fillOf(words: string): HTMLElement {
  const item = screen.getByText(words).closest("[data-mine]");
  if (!(item instanceof HTMLElement)) throw new Error(`no message holds "${words}"`);
  const fill = item.querySelector<HTMLElement>("[data-message-fill]");
  if (!fill) throw new Error(`"${words}" has no fill`);
  return fill;
}

describe("MessageThread messages", () => {
  const two = [
    msg({ id: "a", from: "me", body: "From me", sentAt: T0 }),
    msg({ id: "b", from: "them", body: "From them", sentAt: T0 + MINUTE }),
  ];

  it("draws your messages and theirs differently", () => {
    render(() => <MessageThread messages={two} emptyHint="Hint" />);
    expect(fillOf("From me").className).not.toBe(fillOf("From them").className);
  });

  it("marks whose each message is where the portals' tests look", () => {
    render(() => <MessageThread messages={two} emptyHint="Hint" />);
    expect(screen.getByText("From me").closest("[data-mine]")).toHaveAttribute("data-mine", "true");
    expect(screen.getByText("From them").closest("[data-mine]")).toHaveAttribute(
      "data-mine",
      "false",
    );
  });

  it("tells a screen reader who wrote each message and when", () => {
    render(() => <MessageThread messages={two} emptyHint="Hint" />);
    const mine = screen.getByText("From me").closest("li");
    const theirs = screen.getByText("From them").closest("li");
    expect(mine?.textContent).toContain(`You wrote at ${clockTime(T0)}: `);
    expect(theirs?.textContent).toContain(`They wrote at ${clockTime(T0 + MINUTE)}: `);
  });

  it("says a message waiting for the vendor has not been delivered", () => {
    render(() => (
      <MessageThread
        messages={[msg({ id: "pending", from: "me", body: "Waiting", undelivered: true })]}
        emptyHint="Hint"
      />
    ));
    expect(screen.getByText("Waiting").closest("li")?.textContent).toContain(
      `You wrote at ${clockTime(T0)}, not delivered yet: `,
    );
  });

  it("puts the oldest first, whatever order the list arrives in", () => {
    render(() => <MessageThread messages={[two[1]!, two[0]!]} emptyHint="Hint" />);
    const words = [...document.querySelectorAll("[data-message-fill]")].map((el) =>
      el.textContent?.replace(/^.*?: /, ""),
    );
    expect(words).toEqual(["From me", "From them"]);
  });

  it("opens each segment with one time line that names its list", () => {
    const thread = [
      msg({ id: "a", sentAt: T0 }),
      msg({ id: "b", sentAt: T0 + 30 * MINUTE }),
      msg({ id: "c", sentAt: T0 + 3 * 60 * MINUTE }),
    ];
    render(() => <MessageThread messages={thread} emptyHint="Hint" />);
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(2);
    expect(lists.map((list) => list.querySelectorAll("li").length)).toEqual([2, 1]);
    for (const [index, list] of lists.entries()) {
      const label = document.getElementById(list.getAttribute("aria-labelledby") ?? "");
      expect(label?.textContent).toBe(dividerLabel(thread[index === 0 ? 0 : 2]!.sentAt));
      expect(label?.closest("time")).not.toBeNull();
    }
  });

  it("holds one sender's run close and spaces a change of sender", () => {
    const thread = [
      msg({ id: "a", from: "them", body: "First", sentAt: T0 }),
      msg({ id: "b", from: "them", body: "Same sender", sentAt: T0 + MINUTE }),
      msg({ id: "c", from: "me", body: "Other sender", sentAt: T0 + 2 * MINUTE }),
    ];
    render(() => <MessageThread messages={thread} emptyHint="Hint" />);
    const item = (words: string) => screen.getByText(words).closest("li")!;
    expect(item("Same sender").className).toMatch(/\bbase:mt-1\b/);
    expect(item("Other sender").className).toMatch(/\bbase:mt-3\b/);
  });

  it("puts exactly one message in the tab order, the newest", () => {
    const thread = [msg({ id: "a", sentAt: T0 }), msg({ id: "b", sentAt: T0 + MINUTE })];
    render(() => <MessageThread messages={[thread[1]!, thread[0]!]} emptyHint="Hint" />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("tabindex"))).toEqual(["-1", "0"]);
  });
});

describe("MessageThread with no messages", () => {
  it("says the thread is empty, with the caller's next step", () => {
    render(() => <MessageThread messages={[]} emptyHint="Your reply will start the thread." />);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(screen.getByText("Your reply will start the thread.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("says it is loading, and not that it is empty", () => {
    render(() => <MessageThread messages={[]} loading emptyHint="Hint" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading messages…");
    expect(screen.queryByText("No messages yet")).not.toBeInTheDocument();
  });

  it("raises a failed read as an alert, and not as an empty thread", () => {
    render(() => <MessageThread messages={[]} error="Could not load messages." emptyHint="Hint" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load messages.");
    expect(screen.queryByText("No messages yet")).not.toBeInTheDocument();
  });
});

describe("MessageThread reply box", () => {
  const box = () => screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
  const send = () => document.querySelector<HTMLButtonElement>("button[aria-label='Send']")!;

  it("draws no reply box when there is nothing to reply with", () => {
    render(() => <MessageThread messages={[]} emptyHint="Hint" />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps the send button out of reach until there is something to send", () => {
    render(() => <MessageThread messages={[]} emptyHint="Hint" reply={{ onSend: vi.fn() }} />);
    expect(send()).toBeDisabled();
    expect(send()).toHaveAttribute("aria-hidden", "true");
    expect(send()).toHaveAttribute("tabindex", "-1");
    fireEvent.input(box(), { target: { value: "   " } });
    expect(send()).toBeDisabled();
    fireEvent.input(box(), { target: { value: "Hello" } });
    expect(send()).toBeEnabled();
    expect(send()).not.toHaveAttribute("aria-hidden");
    expect(send()).not.toHaveAttribute("tabindex", "-1");
  });

  it("sends the trimmed text once, then clears the box", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(() => <MessageThread messages={[]} emptyHint="Hint" reply={{ onSend }} />);
    fireEvent.input(box(), { target: { value: "  Hello there  " } });
    fireEvent.click(send());
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Hello there");
    expect(send()).toHaveAttribute("aria-busy", "true");
    resolve();
    await waitFor(() => expect(box().value).toBe(""));
    expect(box().style.height).toBe("");
  });

  it("keeps the text when the send fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("offline"));
    render(() => <MessageThread messages={[]} emptyHint="Hint" reply={{ onSend }} />);
    fireEvent.input(box(), { target: { value: "Keep me" } });
    fireEvent.click(send());
    await waitFor(() => expect(send()).not.toHaveAttribute("aria-busy", "true"));
    expect(box().value).toBe("Keep me");
  });

  it("shows the caller's error under the box and marks the box invalid", () => {
    render(() => (
      <MessageThread
        messages={[]}
        emptyHint="Hint"
        reply={{ onSend: vi.fn(), error: "Your reply did not send." }}
      />
    ));
    expect(screen.getByText("Your reply did not send.")).toBeInTheDocument();
    expect(box()).toHaveAttribute("aria-invalid", "true");
  });
});
