import { createUniqueId, type JSX } from "solid-js";

import { clockTime } from "./lib/message-time";
import Reveal from "./reveal";

/** One message in an enquiry thread. */
export interface MessageThreadItem {
  id: string;
  /** Whose side of the thread it sits on. */
  from: "me" | "them";
  body: string;
  /** When it was sent, in epoch milliseconds. */
  sentAt: number;
  /** Written, but not yet passed on: the couple's first message before the vendor has an account. */
  undelivered?: boolean;
}

/** How far a message sits from the one above it: after a time line, in one sender's run, or at a change of sender. */
export type MessageSpacing = "first" | "same" | "change";

/**
 * Each side's fill (the owner's answer on englishstreetventures/osn#1850): your
 * own words on a 20% gold wash, theirs on half the surface inside a hairline.
 * Yours keep a transparent edge, so a one-line message is the same height on
 * either side. Both clear 4.5:1 in full ink on the page and inside a card, in
 * both ramps (`tests/message-thread.browser.test.tsx`).
 */
const FILL_BASE =
  "base:rounded-ui-lg base:border base:px-4 base:py-2.5 base:font-ui-body base:text-ui-base base:text-ui-ink " +
  "base:whitespace-pre-line base:[overflow-wrap:anywhere]";

const FILL = {
  me: "base:border-transparent base:bg-ui-accent/20",
  them: "base:border-ui-hairline base:bg-ui-surface/50",
} satisfies Readonly<Record<MessageThreadItem["from"], string>>;

/** A row's side: the column's end for yours, its start for theirs. */
const SIDE = {
  me: "base:self-end base:items-end",
  them: "base:self-start base:items-start",
} satisfies Readonly<Record<MessageThreadItem["from"], string>>;

/** 8px under a time line, 4px inside one sender's run, 12px where the sender changes. */
const SPACING = {
  first: "base:mt-2",
  same: "base:mt-1",
  change: "base:mt-3",
} satisfies Readonly<Record<MessageSpacing, string>>;

/**
 * The row. Its focus ring follows the bubble's corner; the ring has no
 * transition of its own to inherit, so it lands at once.
 */
const ROW =
  "base:flex base:max-w-3/4 base:flex-col base:rounded-ui-lg " +
  "base:focus-visible:outline-2 base:focus-visible:outline-solid base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus";

/** What a screen reader hears before the words: who, when, and whether it has gone. */
export function spokenPrefix(message: MessageThreadItem): string {
  const time = clockTime(message.sentAt);
  const who = message.from === "me" ? "You wrote" : "They wrote";
  return `${who}${time ? ` at ${time}` : ""}${message.undelivered ? ", not delivered yet" : ""}: `;
}

/** The line a tap shows under the message. Empty when there is nothing to say. */
export function revealedLine(message: MessageThreadItem): string {
  const time = clockTime(message.sentAt);
  if (message.undelivered) return time ? `Written ${time}, not delivered yet` : "Not delivered yet";
  return time ? `Sent ${time}` : "";
}

interface MessageBubbleProps {
  message: MessageThreadItem;
  spacing: MessageSpacing;
  /** Whether the tapped time line shows. */
  revealed: boolean;
  /** Whether this row is the thread's one tab stop. */
  current: boolean;
}

/**
 * One message: a row on its side of the column, holding the words and, when
 * tapped, the time it was sent. The thread owns every handler; the row carries
 * `data-message-id` for it to find, and `data-mine`, which both portals' tests
 * read from the words up.
 */
export default function MessageBubble(props: MessageBubbleProps): JSX.Element {
  const line = () => revealedLine(props.message);
  const who = createUniqueId();
  const words = createUniqueId();
  return (
    <li
      data-message-id={props.message.id}
      data-mine={String(props.message.from === "me")}
      // Named from two elements: who wrote it, which only `from` decides, then
      // the words. Inside the words, a line typed to read "You wrote at …" stays
      // part of the other side's message for a screen reader, as it does on screen.
      aria-labelledby={`${who} ${words}`}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a roving tab stop over the thread's messages: exactly one row is in the tab order, and the arrow keys move between them, so a keyboard reaches each message's time and menu without a tab stop per message.
      tabindex={props.current ? 0 : -1}
      class={`${ROW} ${SIDE[props.message.from]} ${SPACING[props.spacing]}`}
    >
      <span id={who} class="base:sr-only">
        {spokenPrefix(props.message)}
      </span>
      <div id={words} data-message-fill class={`${FILL_BASE} ${FILL[props.message.from]}`}>
        {props.message.body}
      </div>
      <Reveal when={props.revealed && line() !== ""}>
        {/* Hidden from assistive tech: the spoken prefix already says when. */}
        <p
          aria-hidden="true"
          class="base:px-1 base:pt-1 base:text-ui-xs base:leading-4 base:text-ui-ink-secondary"
        >
          {line()}
        </p>
      </Reveal>
    </li>
  );
}
