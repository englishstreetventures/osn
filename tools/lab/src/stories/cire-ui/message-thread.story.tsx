import { cardClass } from "@cire/ui/card";
import MessageThread, { type MessageThreadItem } from "@cire/ui/message-thread";
import { For, onCleanup, onMount, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/MessageThread", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";
const THEME_OPTIONS = ["both", "dark", "light"] as const;
const themesFor = (choice: ThemeChoice): CireTheme[] =>
  choice === "both" ? ["dark", "light"] : [choice];

/**
 * The portals' motion tokens, which the contract does not carry: the desk
 * steps and the spring the send button arrives on, as `cire/host`'s
 * stylesheet declares them.
 */
const MOTION: JSX.CSSProperties = {
  "--dur-fast": "90ms",
  "--dur-base": "150ms",
  "--dur-slow": "200ms",
  "--ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
  "--ease-spring": "cubic-bezier(0.34, 1.32, 0.64, 1)",
};

/** The two grounds a thread sits on: the host's page, the vendor's card. */
type Ground = "page" | "card";

function CirePanel(props: { theme: CireTheme; ground: Ground; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-4 border p-5"
      style={{ ...cireStyle(props.theme), ...MOTION }}
    >
      <Eyebrow>
        cire · {props.theme} · {props.ground === "page" ? "host, on the page" : "vendor, in a card"}
      </Eyebrow>
      {props.ground === "card" ? <div class={cardClass()}>{props.children}</div> : props.children}
    </div>
  );
}

function Panels(props: { theme: ThemeChoice; ground: Ground; children: () => JSX.Element }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={themesFor(props.theme)}>
        {(theme) => (
          <CirePanel theme={theme} ground={props.ground}>
            {props.children()}
          </CirePanel>
        )}
      </For>
    </div>
  );
}

interface ThreadArgs extends StoryArgs {
  cireTheme: ThemeChoice;
  ground: Ground;
}
const controls = {
  cireTheme: { kind: "select" as const, options: THEME_OPTIONS },
  ground: { kind: "select" as const, options: ["page", "card"] as const },
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A moment `days` before today at the wall-clock time given. */
function daysAgo(days: number, hour: number, minute: number): number {
  const at = new Date(Date.now() - days * DAY);
  at.setHours(hour, minute, 0, 0);
  return at.getTime();
}

/** An enquiry from the couple's side: segments across a week, runs on each side. */
const THREAD: MessageThreadItem[] = [
  {
    id: "1",
    from: "me",
    body: "Hi! Are you free on 14 March? We're planning for about 120 guests.",
    sentAt: daysAgo(9, 9, 12),
  },
  {
    id: "2",
    from: "them",
    body: "We are! Could you tell me a little about the venue?",
    sentAt: daysAgo(9, 9, 40),
  },
  { id: "3", from: "me", body: "It's the garden room at Bellmont.", sentAt: daysAgo(9, 9, 52) },
  { id: "4", from: "me", body: "Ceremony at 3, dinner from 6.", sentAt: daysAgo(9, 9, 53) },
  {
    id: "5",
    from: "them",
    body: "Lovely. I'll put a quote together this afternoon.",
    sentAt: daysAgo(9, 14, 5),
  },
  {
    id: "6",
    from: "them",
    body: "Quote's in: canapés, mains and a late supper for 120.",
    sentAt: daysAgo(3, 11, 30),
  },
  { id: "7", from: "them", body: "Happy to adjust anything.", sentAt: daysAgo(3, 11, 31) },
  {
    id: "8",
    from: "me",
    body: "Thank you! Could we swap the late supper for a dessert table?",
    sentAt: daysAgo(1, 18, 20),
  },
  { id: "9", from: "them", body: "Of course. I've updated the quote.", sentAt: daysAgo(0, 10, 5) },
  { id: "10", from: "me", body: "Perfect, thank you!", sentAt: daysAgo(0, 10, 12) },
];

/** The same thread from the vendor's side. */
const FROM_VENDOR = THREAD.map((m) => ({ ...m, from: m.from === "me" ? "them" : "me" }) as const);

/** Taps the newest message on mount, as a finger would, so the time line shows. */
function Tapped(props: { children: JSX.Element }) {
  let wrap: HTMLDivElement | undefined;
  onMount(() => {
    const rows = wrap?.querySelectorAll<HTMLElement>("[data-message-id]");
    const last = rows?.item(rows.length - 1);
    last?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    last?.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
  });
  return <div ref={wrap}>{props.children}</div>;
}

/**
 * Right-clicks a message on mount, once the menu's module has arrived, so the
 * info shows. The menu portals to `<body>`, outside the panel that carries
 * cire's mapping, so the mapping is lent to `<body>` while the story is up; in
 * a portal it is on `:root` already.
 */
function RightClicked(props: { theme: CireTheme; children: JSX.Element }) {
  let wrap: HTMLDivElement | undefined;
  onMount(() => {
    const lent = Object.entries({ ...cireStyle(props.theme), ...MOTION });
    for (const [name, value] of lent) document.body.style.setProperty(name, String(value));
    onCleanup(() => {
      for (const [name] of lent) document.body.style.removeProperty(name);
    });
    const target = wrap?.querySelectorAll<HTMLElement>("[data-message-id]").item(7);
    const thread = target?.closest("ol")?.parentElement?.parentElement;
    thread?.dispatchEvent(new PointerEvent("pointerenter"));
    window.setTimeout(() => {
      if (!target) return;
      const box = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: box.left + 24,
          clientY: box.bottom - 4,
        }),
      );
    }, 300);
  });
  return <div ref={wrap}>{props.children}</div>;
}

const noSend = () => new Promise<void>(() => {});

/** The couple's thread on the host's page: segments, runs, and the reply box. */
export const Thread: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <MessageThread
          messages={THREAD}
          emptyHint="Your message will start the thread."
          reply={{ onSend: noSend }}
        />
      )}
    </Panels>
  ),
};

/** The vendor's side of the same thread, inside the card its portal draws it on. */
export const InCard: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "card" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <MessageThread
          messages={FROM_VENDOR}
          emptyHint="Your reply will start the thread."
          reply={{ onSend: noSend }}
        />
      )}
    </Panels>
  ),
};

/** Long words: a paragraph that wraps, line breaks as typed, and a long unbroken link. */
export const LongMessages: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <MessageThread
          messages={[
            {
              id: "l1",
              from: "them",
              body: "Thanks for the details. A few things before I quote:\n\n1. Is there a kitchen on site?\n2. Do you need staff for the ceremony as well?\n3. Any dietary needs I should plan for?",
              sentAt: daysAgo(0, 9, 0),
            },
            {
              id: "l2",
              from: "me",
              body: "Here's the venue's kit list: https://bellmont.example/venues/garden-room/catering-equipment-and-kitchen-specifications-2026.pdf",
              sentAt: daysAgo(0, 9, 20),
            },
          ]}
          emptyHint="Your message will start the thread."
        />
      )}
    </Panels>
  ),
};

/** The newest message tapped: its time shows under it. */
export const TimeShown: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <Tapped>
          <MessageThread messages={THREAD.slice(-3)} emptyHint="Hint" />
        </Tapped>
      )}
    </Panels>
  ),
};

/** A message right-clicked: who sent it, the whole date, Copy text. */
export const InfoMenu: Story<ThreadArgs> = {
  args: { cireTheme: "dark", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <RightClicked theme={args.cireTheme === "light" ? "light" : "dark"}>
          <MessageThread messages={THREAD} emptyHint="Hint" />
        </RightClicked>
      )}
    </Panels>
  ),
};

/** The couple's first message, held until the vendor has an account. */
export const Undelivered: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <Tapped>
          <MessageThread
            messages={[
              {
                id: "pending",
                from: "me",
                body: "Hi! Are you free on 14 March?",
                sentAt: daysAgo(0, 9, 12),
                undelivered: true,
              },
            ]}
            emptyHint="Hint"
          />
        </Tapped>
      )}
    </Panels>
  ),
};

/** No messages: the quiet centred line, in the voice of the time lines. */
export const Empty: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "card" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <MessageThread
          messages={[]}
          emptyHint="Your reply will start the thread."
          reply={{ onSend: noSend }}
        />
      )}
    </Panels>
  ),
};

/** On its way, and a read that failed. */
export const LoadingAndError: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <div class="flex flex-col gap-6">
          <MessageThread messages={[]} loading emptyHint="Hint" />
          <MessageThread
            messages={[]}
            error="Could not load messages. Please refresh."
            emptyHint="Hint"
          />
        </div>
      )}
    </Panels>
  ),
};

/** The reply box: type into it to watch the send button spring in; a failed send's error under it. */
export const Reply: Story<ThreadArgs> = {
  args: { cireTheme: "both", ground: "page" },
  controls,
  render: (args) => (
    <Panels theme={args.cireTheme} ground={args.ground}>
      {() => (
        <div class="flex flex-col gap-6">
          <Caption name="Empty" value="No send button. Type to bring it in." />
          <MessageThread
            messages={[]}
            emptyHint="Your reply will start the thread."
            reply={{ onSend: () => new Promise((resolve) => window.setTimeout(resolve, 600)) }}
          />
          <Caption name="Failed" value="The words stay; the error shows under the box." />
          <MessageThread
            messages={[]}
            emptyHint="Your reply will start the thread."
            reply={{ onSend: noSend, error: "Your reply did not send. Try again." }}
          />
        </div>
      )}
    </Panels>
  ),
};
