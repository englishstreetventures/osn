import { Notice } from "@shared/ui/ui/notice";
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  lazy,
  Show,
  Suspense,
  type JSX,
} from "solid-js";

import { dividerLabel, orderMessages, segmentMessages } from "./lib/message-time";
import Loading from "./loading";
import MessageBubble, { type MessageSpacing, type MessageThreadItem } from "./message-bubble";
import MessageComposer, { type MessageComposerProps } from "./message-composer";

export type { MessageThreadItem } from "./message-bubble";

/** One loader for the menu's module, shared by the early fetch and `lazy()`. */
const loadMenu = () => import("./message-info-menu");
const MessageInfoMenu = lazy(loadMenu);

/** The reply box's props: what sending does, the placeholder, and an error to show under it. */
export type MessageThreadReply = MessageComposerProps;

export interface MessageThreadProps {
  messages: readonly MessageThreadItem[];
  /** True while the messages are on their way; the list stays if it has any. */
  loading?: boolean;
  /** A failed read, raised as an alert. */
  error?: string | null;
  /** The line under "No messages yet": what starts the thread from this side. */
  emptyHint: string;
  /** The reply box; left out where this reader cannot reply. */
  reply?: MessageThreadReply;
}

/** A `contextmenu` this soon after a key opened the menu is the browser's echo of that key. */
const KEY_ECHO_MS = 500;

/** Whether the page's selection holds text inside `row`. */
function selectionInside(row: Element): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return row.contains(selection.getRangeAt(0).commonAncestorContainer);
}

function rowOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-message-id]") : null;
}

const isMenuKey = (event: KeyboardEvent) =>
  event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

/** The pointer a click came from: the event's own, where the browser gives one. */
function clickPointer(event: MouseEvent, fallback: string): string {
  return typeof PointerEvent !== "undefined" && event instanceof PointerEvent && event.pointerType
    ? event.pointerType
    : fallback;
}

/**
 * An enquiry thread: the messages between a couple and a vendor, read from
 * either side, and the box to reply in. Both portals render it (host
 * DESIGN.md §7, "An enquiry thread").
 *
 * ## How it reads
 *
 * Oldest first, whatever order the list arrives in (the API sends newest
 * first). No message carries its own time. The thread is cut into segments
 * wherever more than an hour passed or the date changed, and one centred line
 * opens each: "Today 10:05 am", "Yesterday 6:20 pm", "Tue 11:30 am",
 * "Wed 14 Oct, 9:12 am" (`lib/message-time.ts`). One sender's messages in a row
 * sit 4px apart, and a change of sender 12px. A thread with no messages says
 * so, in the same quiet centred voice as the time lines.
 *
 * ## What it answers to
 *
 * - **A tap on a phone** shows "Sent 10:12 am" under that message; a second
 *   tap, or a tap on another, hides it. A mouse click does nothing.
 * - **A right-click** on a message opens its info (`message-info-menu.tsx`):
 *   who sent it, the whole date, "Copy text". Not on words that were already
 *   selected, where the browser's own menu copies the selection, and never
 *   after a touch, so a long press keeps the phone's own text callout.
 * - **The keyboard**: the messages are one tab stop. The arrow keys, Home and
 *   End move between them; Enter or Space shows the time; Escape hides it;
 *   Shift+F10 or the menu key opens the info.
 *
 * A screen reader hears who wrote each message and when before its words, so
 * the time a tap shows is hidden from it.
 *
 * ## The menu's code
 *
 * The menu is Kobalte's, which a portal's first load should not carry for a
 * thread nobody right-clicks. Its module starts loading the first time a
 * pointer enters the thread or focus lands in it, and until it has arrived a
 * right-click is left to the browser rather than swallowed; a download that
 * fails leaves it with the browser for good. Its own `Suspense` holds the
 * wait, so the boundary a portal wraps its view in never shows its fallback.
 *
 * ## Holding its place
 *
 * Messages are matched by id, so a send, a refetch or a new message from the
 * other side keeps every row that is still there — and the focus in it.
 */
export default function MessageThread(props: MessageThreadProps): JSX.Element {
  const ordered = createMemo(() => orderMessages(props.messages));
  const byId = createMemo(() => new Map(ordered().map((m) => [m.id, m])));
  /** The segments as ids, so the rows are matched by id rather than by object. */
  const segments = createMemo(() =>
    segmentMessages(ordered()).map((segment) => segment.map((m) => m.id)),
  );

  const [revealedId, setRevealedId] = createSignal<string | null>(null);
  const [chosenId, setChosenId] = createSignal<string | null>(null);
  /** The thread's one tab stop: the row last moved to, or the newest. */
  const currentId = createMemo(() => {
    const chosen = chosenId();
    return chosen !== null && byId().has(chosen) ? chosen : (ordered().at(-1)?.id ?? null);
  });

  const [menuFor, setMenuFor] = createSignal<MessageThreadItem | null>(null);
  const [menuAt, setMenuAt] = createSignal({ x: 0, y: 0 });
  const [menuReady, setMenuReady] = createSignal(false);

  const idPrefix = createUniqueId();
  let root: HTMLDivElement | undefined;
  let lastPointer = "mouse";
  let selectedAtRightPress = false;
  let keyMenuAt = Number.NEGATIVE_INFINITY;
  let menuRequested = false;

  const rows = () => [...(root?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])];
  const rowById = (id: string | null) => rows().find((row) => row.dataset.messageId === id);

  function fetchMenu() {
    if (menuRequested) return;
    menuRequested = true;
    loadMenu().then(
      () => setMenuReady(true),
      () => {
        // Left to the browser's own menu; there is nothing to tell the reader.
      },
    );
  }

  function toggle(id: string) {
    setRevealedId((open) => (open === id ? null : id));
  }

  function openMenu(row: HTMLElement, at: { x: number; y: number }) {
    const message = byId().get(row.dataset.messageId ?? "");
    if (!message) return;
    setChosenId(message.id);
    setMenuAt(at);
    setMenuFor(message);
  }

  function moveTo(row: HTMLElement | undefined) {
    if (!row) return;
    setChosenId(row.dataset.messageId ?? null);
    row.focus();
  }

  /** An event from inside the open menu, which reaches these handlers through its portal. */
  const fromMenu = (target: EventTarget | null) =>
    menuFor() !== null && target instanceof Node && !root?.contains(target);

  function onPointerDown(event: PointerEvent) {
    lastPointer = event.pointerType;
    if (event.pointerType === "mouse" && event.button === 2) {
      // Read before the browser acts on the press: macOS selects the word
      // under the pointer before `contextmenu` fires.
      const row = rowOf(event.target);
      selectedAtRightPress = row !== null && selectionInside(row);
    }
  }

  function onClick(event: MouseEvent) {
    const pointer = clickPointer(event, lastPointer);
    if (pointer !== "touch" && pointer !== "pen") return;
    const row = rowOf(event.target);
    if (!row?.dataset.messageId || selectionInside(row)) return;
    toggle(row.dataset.messageId);
  }

  function onContextMenu(event: MouseEvent) {
    if (performance.now() - keyMenuAt < KEY_ECHO_MS) {
      event.preventDefault();
      return;
    }
    if (fromMenu(event.target)) {
      event.preventDefault();
      return;
    }
    const row = rowOf(event.target);
    if (!row || !menuReady() || selectedAtRightPress) return;
    if (lastPointer === "touch" || lastPointer === "pen") return;
    event.preventDefault();
    // The word the press selected (macOS) is not a choice the reader made.
    window.getSelection()?.removeAllRanges();
    openMenu(row, { x: event.clientX, y: event.clientY });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (fromMenu(event.target)) {
      if (isMenuKey(event)) event.preventDefault();
      return;
    }
    const row = rowOf(event.target);
    if (!row || event.target !== row) return;
    const id = row.dataset.messageId ?? "";
    if (isMenuKey(event)) {
      event.preventDefault();
      if (!menuReady()) return;
      keyMenuAt = performance.now();
      const box = row.getBoundingClientRect();
      openMenu(row, { x: box.left, y: box.bottom });
      return;
    }
    const all = rows();
    const index = all.indexOf(row);
    switch (event.key) {
      case "ArrowDown":
        moveTo(all[index + 1]);
        break;
      case "ArrowUp":
        moveTo(all[index - 1]);
        break;
      case "Home":
        moveTo(all[0]);
        break;
      case "End":
        moveTo(all.at(-1));
        break;
      case "Enter":
      case " ":
        toggle(id);
        break;
      case "Escape":
        if (revealedId() !== id) return;
        setRevealedId(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** The run spacing of each message, by its place in its segment. */
  function spacingFor(segment: readonly string[], index: number): MessageSpacing {
    if (index === 0) return "first";
    const map = byId();
    return map.get(segment[index - 1] ?? "")?.from === map.get(segment[index] ?? "")?.from
      ? "same"
      : "change";
  }

  const empty = () => !props.loading && !props.error && ordered().length === 0;

  return (
    <div class="base:flex base:flex-col base:gap-4">
      <Show when={props.error}>
        {(error) => (
          <Notice tone="danger" alert>
            {error()}
          </Notice>
        )}
      </Show>
      <Show when={props.loading && ordered().length === 0}>
        <Loading label="Loading messages…" />
      </Show>
      <Show when={empty()}>
        <div class="base:text-center base:text-ui-ink-secondary">
          <p class="base:text-ui-sm base:leading-5">No messages yet</p>
          <p class="base:text-ui-xs base:leading-4">{props.emptyHint}</p>
        </div>
      </Show>
      <Show when={ordered().length > 0}>
        <div
          ref={root}
          class="base:flex base:flex-col"
          onPointerEnter={fetchMenu}
          onFocusIn={(event) => {
            fetchMenu();
            // The row with focus is the tab stop, so a message arriving while
            // the reader is on the newest one does not take the stop from them.
            const row = rowOf(event.target);
            if (row?.dataset.messageId) setChosenId(row.dataset.messageId);
          }}
          onPointerDown={onPointerDown}
          on:click={onClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
        >
          <Index each={segments()}>
            {(segment, segmentIndex) => {
              const labelId = `${idPrefix}-segment-${segmentIndex}`;
              const opensAt = () => byId().get(segment()[0] ?? "")?.sentAt ?? Number.NaN;
              return (
                <div class="base:mt-5 base:first:mt-0">
                  <p class="base:text-center base:text-ui-xs base:leading-4 base:text-ui-ink-secondary">
                    <time
                      id={labelId}
                      dateTime={
                        Number.isFinite(opensAt()) ? new Date(opensAt()).toISOString() : undefined
                      }
                    >
                      {dividerLabel(opensAt())}
                    </time>
                  </p>
                  <ol aria-labelledby={labelId} class="base:flex base:flex-col">
                    <For each={segment()}>
                      {(id, index) => (
                        <Show when={byId().get(id)}>
                          {(message) => (
                            <MessageBubble
                              message={message()}
                              spacing={spacingFor(segment(), index())}
                              revealed={revealedId() === id}
                              current={currentId() === id}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </ol>
                </div>
              );
            }}
          </Index>
          <Show when={menuReady()}>
            {/* Inside the list's root, so the menu's events, which Solid carries
                from its portal back to here, reach the root's handlers. Its own
                boundary: the module has arrived, but `lazy()` still suspends for
                a tick, and the one above is a portal's whole view. */}
            <Suspense>
              <MessageInfoMenu
                message={menuFor()}
                at={menuAt()}
                onClose={() => setMenuFor(null)}
                onReturnFocus={() => rowById(chosenId())?.focus()}
                onCopyRefused={() => {
                  const fill = rowById(chosenId())?.querySelector("[data-message-fill]");
                  if (fill) window.getSelection()?.selectAllChildren(fill);
                }}
              />
            </Suspense>
          </Show>
        </div>
      </Show>
      <Show when={props.reply}>
        {(reply) => (
          <MessageComposer
            onSend={(text) => reply().onSend(text)}
            placeholder={reply().placeholder}
            error={reply().error}
          />
        )}
      </Show>
    </div>
  );
}
