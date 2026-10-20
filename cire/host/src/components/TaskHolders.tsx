import { Popover } from "@kobalte/core/popover";
import { Notice } from "@shared/ui/ui/notice";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Show,
} from "solid-js";

import { type HostSeat, seatName } from "../lib/hosts-store";
import { ROLE_COPY } from "../lib/wedding-roles";
import PersonAvatar from "./PersonAvatar";

/** One holder of a task, in stack order. `seat` is absent while the wedding's
 *  seats have not loaded, and there is no name or photo to give yet. */
export interface Holder {
  hostId: string;
  seat?: HostSeat;
}

/** Faces on a stack before the rest are counted in a "+N" bubble. */
const FACES = 3;
/** More people than this, and the popover opens on a search. */
const SEARCH_ABOVE = 5;

/** Built on the first list a row names, then kept for every row after. */
let conjunction: Intl.ListFormat | undefined;
/** "Sam Lee, @jo and Priya Raman". */
const listOf = (names: string[]) =>
  (conjunction ??= new Intl.ListFormat("en-AU", { type: "conjunction" })).format(names);

interface TaskHoldersProps {
  /** The task's title, for the trigger's name. */
  title: string;
  /** The task is open, not done. */
  open: boolean;
  /** Who holds it, reader first, then in the order they were put on it. A
   *  seat that has gone is left out once the seats have loaded. */
  holders: readonly Holder[];
  /** An owner or editor: the stack is a trigger, with the + on top. */
  canAssign: boolean;
  /** Every seat on the wedding, or `null` until they load. */
  seats: readonly HostSeat[] | null;
  /** The seats could not be read. */
  seatsFailed: boolean;
  /** The reader's own seat, listed first and marked as them. */
  viewerHostId: string | null;
  /** Does the seat show as holding the task, picks still out included? */
  holds: (hostId: string) => boolean;
  /** A write of this task is out. */
  busy: boolean;
  /** The popover is opening: read the seats it offers. */
  onOpen: () => void;
  /** Put the seat on the task, or take it off. */
  onToggle: (hostId: string) => void;
}

/**
 * Who holds a checklist task, on its row: an overlapping stack of faces, the
 * reader first, three of them and then a "+N" bubble.
 *
 * An owner or editor sees the stack as one control, with a dotted circle
 * holding a + as its top-right layer — there even on a task nobody holds — and
 * it opens a popover that puts people on the task and takes them off. Anyone
 * else sees the faces alone; an open task nobody holds shows them an empty
 * dotted circle, and a done one nothing at all.
 *
 * The faces are pictures only. The names are in text beside them, for every
 * role: "Held by Sam Lee and @jo".
 */
export default function TaskHolders(props: TaskHoldersProps) {
  // The faces go by seat id, so a change of who holds the task, or the seats
  // arriving, keeps every face still there — and its photo, and whether that
  // photo failed to load — rather than building it again.
  const faces = createMemo(() => props.holders.slice(0, FACES).map((h) => h.hostId));
  const rest = () => props.holders.slice(FACES);
  const holderById = createMemo(() => new Map(props.holders.map((h) => [h.hostId, h])));
  const nameOf = (holder: Holder | undefined) => (holder?.seat ? seatName(holder.seat) : undefined);

  const heldBy = () => {
    const holders = props.holders;
    if (holders.length === 0) return null;
    if (holders.some((h) => !h.seat)) {
      return `Held by ${holders.length} ${holders.length === 1 ? "person" : "people"}`;
    }
    return `Held by ${listOf(holders.map((h) => nameOf(h)!))}`;
  };

  // The count overlaps the + by half as much as the faces overlap each other,
  // so the + never covers its figure.
  //
  // Each layer of the stack is positioned (the faces are, for their photos),
  // so they paint in document order and every one covers the edge of the one
  // before it — the + last, on top. One left static would paint under all of
  // them. A face's own name shows on hover, for a sighted reader with a mouse;
  // a screen reader hears the names once, from the text above.
  const stack = (): JSX.Element => (
    <>
      <For each={faces()}>
        {(hostId) => {
          const holder = () => holderById().get(hostId);
          return (
            <span data-holder={hostId} title={nameOf(holder())} class="rounded-full">
              <PersonAvatar url={holder()?.seat?.avatarUrl} class="ring-bg size-7 ring-2" />
            </span>
          );
        }}
      </For>
      <Show when={rest().length > 0}>
        <span
          data-more
          aria-hidden="true"
          title={rest()
            .map((h) => nameOf(h))
            .filter(Boolean)
            .join(", ")}
          class="bg-surface-raised text-text border-border-strong ring-bg font-body text-ui-xs relative -me-1 flex size-7 shrink-0 items-center justify-center rounded-full border font-medium tabular-nums ring-2"
        >
          {`+${rest().length}`}
        </span>
      </Show>
    </>
  );

  return (
    <div class="flex shrink-0 items-center">
      <Show when={heldBy()}>{(words) => <span class="sr-only">{words()}</span>}</Show>
      <Show
        when={props.canAssign}
        fallback={
          <Show
            when={props.holders.length > 0}
            fallback={
              <Show when={props.open}>
                <span
                  // A picture with a name: an `<img>` would need a file to show.
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                  role="img"
                  aria-label="Nobody assigned yet"
                  class="border-border-strong block size-7 rounded-full border-2 border-dotted"
                />
              </Show>
            }
          >
            <span aria-hidden="true" class="flex items-center -space-x-2">
              {stack()}
            </span>
          </Show>
        }
      >
        <AssignPopover {...props} stack={stack} />
      </Show>
    </div>
  );
}

/** The + trigger and its popover, for an owner or editor. */
function AssignPopover(props: TaskHoldersProps & { stack: () => JSX.Element }) {
  const [open, setOpen] = createSignal(false);

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) props.onOpen();
      }}
      placement="bottom-end"
      gutter={6}
    >
      <Popover.Trigger
        aria-label={`Assign people to ${props.title}`}
        class="group flex items-center -space-x-2 rounded-full outline-offset-2"
      >
        {props.stack()}
        <span
          data-assign-plus
          aria-hidden="true"
          class="border-border-strong bg-bg text-text-muted group-hover:border-gold group-hover:text-text group-data-[expanded]:border-gold group-data-[expanded]:text-gold-ink ring-bg relative flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-dotted ring-2 transition-colors duration-(--dur-fast)"
        >
          <svg
            viewBox="0 0 16 16"
            class="size-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
          >
            <path d="M8 3.25v9.5M3.25 8h9.5" />
          </svg>
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        {/* Kobalte focuses the first thing in it that takes the focus — the
            search when there is one, else the list — without scrolling: the
            panel opens at the page's top left and is put beside its trigger
            a frame later, and a scrolling focus would jump the page there. */}
        <Popover.Content
          class="assign-popover border-border bg-surface-raised lip z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border shadow-(--elev-2) outline-none"
          onKeyDown={(e: KeyboardEvent) => {
            // Tab would carry the focus out of a popover portalled to the end
            // of the page, past everything; it closes it instead, and the
            // focus goes back to the trigger.
            if (e.key === "Tab") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          <div class="assign-popover-body flex min-h-0 flex-col">
            <Popover.Title class="text-text-muted font-body text-ui-xs tracking-ui-widest px-4 pt-3 pb-2 uppercase">
              Assign people
            </Popover.Title>
            <PeopleList {...props} />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

/** The people in the popover: a listbox of toggles, with a search above it
 *  once there are more than five. */
function PeopleList(props: TaskHoldersProps) {
  const baseId = createUniqueId();
  const listId = `${baseId}-people`;
  const optionId = (index: number) => `${baseId}-person-${index}`;
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let listRef: HTMLUListElement | undefined;
  let searchRef: HTMLInputElement | undefined;

  const searchable = () => (props.seats?.length ?? 0) > SEARCH_ABOVE;
  const seatById = createMemo(() => new Map(props.seats?.map((s) => [s.hostId, s])));
  // By seat id, not by seat object: a re-read of the seats hands back new
  // objects, and a list keyed by object would rebuild every row under the
  // reader's highlight.
  const people = createMemo(() => {
    const ids = (props.seats ?? []).map((s) => s.hostId);
    const me = props.viewerHostId;
    return me !== null && ids.includes(me) ? [me, ...ids.filter((id) => id !== me)] : ids;
  });
  const results = createMemo(() => {
    const q = query().trim().toLowerCase().replace(/^@/, "");
    if (!q || !searchable()) return people();
    return people().filter((id) => {
      const seat = seatById().get(id)!;
      return [seat.displayName, seat.handle, seatName(seat)].some((v) =>
        v?.toLowerCase().includes(q),
      );
    });
  });

  const toggleActive = () => {
    const id = results()[active()];
    if (id !== undefined) props.onToggle(id);
  };

  /** Arrows, Home and End move the highlight; Enter toggles it. Space toggles
   *  only on the list itself: in the search it types the space a name has. */
  const onKeyDown = (e: KeyboardEvent, spaceToggles: boolean) => {
    const count = results().length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (i + 1) % Math.max(count, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (i - 1 + count) % Math.max(count, 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(Math.max(0, count - 1));
        break;
      case "Enter":
        e.preventDefault();
        toggleActive();
        break;
      case " ":
        if (!spaceToggles) break;
        e.preventDefault();
        toggleActive();
        break;
    }
  };

  // Keep the highlight in range as the search narrows the list.
  createEffect(() => {
    const count = results().length;
    if (active() >= count) setActive(Math.max(0, count - 1));
  });

  // Follow the highlight with the scroll, so arrowing past the fold works.
  createEffect(() => {
    const index = active();
    listRef?.querySelector(`[id="${optionId(index)}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  // The seats can arrive after the popover opened on the list alone. When
  // they bring a search, the focus moves into it: Tab closes the popover, so
  // from the list there would be no way to reach it.
  createEffect(() => {
    if (searchable()) searchRef?.focus({ preventScroll: true });
  });

  const activeId = () => (results().length > 0 ? optionId(active()) : undefined);

  /** What the list says beside its options, read out politely as it changes:
   *  that it is still looking, how many people a search matches, or that it
   *  matches nobody. Nothing while the whole list shows. */
  const status = () => {
    if (props.seats === null) return props.seatsFailed ? "" : "Finding the people on this wedding…";
    if (!searchable() || !query().trim()) return "";
    const count = results().length;
    if (count === 0) return `Nobody matches “${query()}”.`;
    return count === 1 ? "1 person matches" : `${count} people match`;
  };

  return (
    <>
      {/* Only while there is nobody to show: seats that arrive take it away
          at once, before the read that brought them reports back. */}
      <Show when={props.seatsFailed && props.seats === null}>
        <div class="px-3 pb-2">
          <Notice tone="danger" alert>
            Couldn't load the people on this wedding. Close this and try again.
          </Notice>
        </div>
      </Show>
      <Show when={searchable()}>
        <div class="border-border focus-within:border-focus focus-within:ring-focus mx-3 mb-1 flex items-center gap-2 rounded-sm border px-2.5 focus-within:ring-1">
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="text-text-faint size-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          >
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3 3" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label="Search people"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId()}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="Search by name or handle"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(e) => onKeyDown(e, false)}
            class="font-body text-text placeholder:text-text-faint text-ui-sm min-w-0 flex-1 bg-transparent py-2 outline-none"
          />
        </div>
      </Show>
      <ul
        ref={listRef}
        id={listId}
        // A `<select multiple>` cannot hold a face and a tick beside each
        // name, so this is the ARIA listbox the command palette also is.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
        role="listbox"
        aria-label="People"
        aria-multiselectable="true"
        aria-busy={props.busy || undefined}
        aria-activedescendant={searchable() ? undefined : activeId()}
        tabindex={searchable() ? -1 : 0}
        onKeyDown={(e) => onKeyDown(e, true)}
        // The house ring, drawn inside: the panel clips anything outside it.
        class="flex min-h-0 flex-col overscroll-contain p-1 focus-visible:-outline-offset-2"
        classList={{ "max-h-[14.75rem] overflow-y-auto": searchable() }}
      >
        <For each={results()}>
          {(hostId, index) => {
            const seat = () => seatById().get(hostId)!;
            const on = () => props.holds(hostId);
            const you = () => hostId === props.viewerHostId;
            const lit = () => active() === index();
            return (
              <li
                id={optionId(index())}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
                role="option"
                aria-selected={on()}
                // The focus stays in the search or on the list: a click on a
                // row must not take it to the popover's frame.
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => setActive(index())}
                onClick={() => {
                  setActive(index());
                  props.onToggle(hostId);
                }}
                // The house ring stays on the search or the list and never
                // reaches a person: a bar in the ring's colour marks the
                // highlighted one instead, with gold ink on the name.
                class="font-body relative flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 transition-colors duration-(--dur-fast) before:absolute before:inset-y-2 before:start-0 before:w-0.75 before:rounded-full"
                classList={{ "bg-gold/10 before:bg-focus": lit() }}
              >
                <span
                  data-toggle
                  data-on={on() || undefined}
                  aria-hidden="true"
                  class="flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-(--dur-fast)"
                  classList={{
                    "border-border-strong": !on(),
                    "border-brand bg-brand text-on-brand": on(),
                  }}
                >
                  <Show when={on()}>
                    <svg
                      data-tick
                      viewBox="0 0 16 16"
                      class="tick-pop size-3"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.25"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m3.5 8.25 3 3 6-6.5" />
                    </svg>
                  </Show>
                </span>
                <PersonAvatar url={seat().avatarUrl} class="size-8" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span
                    data-name
                    class="text-ui-sm truncate"
                    classList={{ "text-gold-ink": lit(), "text-text": !lit() }}
                  >
                    {seatName(seat())}
                  </span>
                  <span class="text-text-muted text-ui-xs truncate">
                    {you() ? `You · ${ROLE_COPY[seat().role].label}` : ROLE_COPY[seat().role].label}
                  </span>
                </span>
              </li>
            );
          }}
        </For>
      </ul>
      {/* Outside the list, which holds people only. Always there, never
          `display: none`, so a screen reader hears each change; the count
          is for a screen reader alone, the rest shows. */}
      <p
        role="status"
        class="text-text-muted text-ui-sm"
        classList={{
          "sr-only": results().length > 0,
          "px-4 pt-3 pb-5": results().length === 0 && status() !== "",
          "text-center": props.seats !== null,
        }}
      >
        {status()}
      </p>
    </>
  );
}
