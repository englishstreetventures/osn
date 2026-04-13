import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { fetchRsvpsByStatus, type Rsvp, type RsvpStatus } from "../lib/rsvps";
import { RsvpAvatar } from "./RsvpAvatar";

interface Event {
  id: string;
  guestListVisibility: "public" | "connections" | "private";
  allowInterested: boolean;
  joinPolicy: "open" | "guest_list";
  createdByProfileId: string;
}

type Tab = "going" | "interested" | "not_going" | "invited";

/**
 * Full RSVP list with tabs for Going / Maybe / Not going / Invited.
 *
 * When `guestListVisibility === "private"` and the viewer isn't the
 * organiser, the modal shows a lock state explaining why the list is
 * hidden. The server-side filter would return an empty list anyway,
 * but a dedicated copy gives better UX than a blank modal.
 */
export function RsvpModal(props: {
  event: Event;
  accessToken: string | null;
  currentProfileId?: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("going");
  const source = createMemo(() => ({
    eventId: props.event.id,
    token: props.accessToken,
    tab: tab(),
  }));
  const [rsvps] = createResource(source, ({ eventId, token, tab: selectedTab }) =>
    fetchRsvpsByStatus(eventId, selectedTab as RsvpStatus, token),
  );

  const isOrganiser = () => props.currentProfileId === props.event.createdByProfileId;
  const locked = () => props.event.guestListVisibility === "private" && !isOrganiser();

  const tabs: { id: Tab; label: string; show: () => boolean }[] = [
    { id: "going", label: "Going", show: () => true },
    { id: "interested", label: "Maybe", show: () => props.event.allowInterested },
    { id: "not_going", label: "Not going", show: () => true },
    { id: "invited", label: "Invited", show: () => props.event.joinPolicy === "guest_list" },
  ];

  return (
    <div
      role="none"
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="bg-card border-border flex max-h-[85vh] w-full flex-col rounded-t-xl border shadow-xl sm:max-w-lg sm:rounded-xl">
        <div class="border-border flex items-center justify-between border-b p-4">
          <h2 class="text-foreground text-base font-semibold">Guest list</h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            class="text-muted-foreground hover:text-foreground text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div class="border-border flex gap-1 overflow-x-auto border-b p-2">
          <For each={tabs.filter((t) => t.show())}>
            {(t) => (
              <button
                type="button"
                onClick={() => setTab(t.id)}
                class={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  tab() === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <Show
            when={!locked()}
            fallback={
              <div class="py-8 text-center">
                <p class="text-muted-foreground text-sm">This event's guest list is private.</p>
                <p class="text-muted-foreground mt-1 text-xs">
                  Only the organiser can see who's attending.
                </p>
              </div>
            }
          >
            <Show when={rsvps.loading}>
              <p class="text-muted-foreground py-4 text-center text-sm">Loading…</p>
            </Show>
            <Show when={!rsvps.loading && (rsvps()?.length ?? 0) === 0}>
              <p class="text-muted-foreground py-4 text-center text-sm">No one here yet.</p>
            </Show>
            <ul class="flex flex-col gap-2">
              <For each={rsvps() ?? []}>
                {(rsvp: Rsvp) => (
                  <li class="flex items-center gap-3">
                    <RsvpAvatar rsvp={rsvp} />
                    <div class="min-w-0 flex-1">
                      <p class="text-foreground truncate text-sm font-medium">
                        {rsvp.user?.displayName ?? `@${rsvp.user?.handle ?? "unknown"}`}
                      </p>
                      <Show when={rsvp.user?.handle && rsvp.user?.displayName}>
                        <p class="text-muted-foreground text-xs">@{rsvp.user!.handle}</p>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </div>
  );
}
