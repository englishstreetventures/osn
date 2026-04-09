import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { fetchRsvpsByStatus, type Rsvp, type RsvpStatus } from "../lib/rsvps";
import { RsvpAvatar } from "./RsvpAvatar";

interface Event {
  id: string;
  guestListVisibility: "public" | "connections" | "private";
  allowInterested: boolean;
  joinPolicy: "open" | "guest_list";
  createdByUserId: string;
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
  currentUserId?: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("going");
  const source = createMemo(() => ({
    eventId: props.event.id,
    token: props.accessToken,
    tab: tab(),
  }));
  const [rsvps] = createResource(source, ({ eventId, token, tab }) =>
    fetchRsvpsByStatus(eventId, tab as RsvpStatus, token),
  );

  const isOrganiser = () => props.currentUserId === props.event.createdByUserId;
  const locked = () => props.event.guestListVisibility === "private" && !isOrganiser();

  const tabs: { id: Tab; label: string; show: () => boolean }[] = [
    { id: "going", label: "Going", show: () => true },
    { id: "interested", label: "Maybe", show: () => props.event.allowInterested },
    { id: "not_going", label: "Not going", show: () => true },
    { id: "invited", label: "Invited", show: () => props.event.joinPolicy === "guest_list" },
  ];

  return (
    <div
      class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="w-full sm:max-w-lg bg-card rounded-t-xl sm:rounded-xl border border-border shadow-xl max-h-[85vh] flex flex-col">
        <div class="flex items-center justify-between p-4 border-b border-border">
          <h2 class="text-base font-semibold text-foreground">Guest list</h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            class="text-muted-foreground hover:text-foreground text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div class="flex gap-1 p-2 border-b border-border overflow-x-auto">
          <For each={tabs.filter((t) => t.show())}>
            {(t) => (
              <button
                type="button"
                onClick={() => setTab(t.id)}
                class={`px-3 py-1.5 rounded-md text-xs font-medium ${
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
              <div class="text-center py-8">
                <p class="text-sm text-muted-foreground">This event's guest list is private.</p>
                <p class="text-xs text-muted-foreground mt-1">
                  Only the organiser can see who's attending.
                </p>
              </div>
            }
          >
            <Show when={rsvps.loading}>
              <p class="text-sm text-muted-foreground text-center py-4">Loading…</p>
            </Show>
            <Show when={!rsvps.loading && (rsvps()?.length ?? 0) === 0}>
              <p class="text-sm text-muted-foreground text-center py-4">No one here yet.</p>
            </Show>
            <ul class="flex flex-col gap-2">
              <For each={rsvps() ?? []}>
                {(rsvp: Rsvp) => (
                  <li class="flex items-center gap-3">
                    <RsvpAvatar rsvp={rsvp} />
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-medium text-foreground truncate">
                        {rsvp.user?.displayName ?? `@${rsvp.user?.handle ?? "unknown"}`}
                      </p>
                      <Show when={rsvp.user?.handle && rsvp.user?.displayName}>
                        <p class="text-xs text-muted-foreground">@{rsvp.user!.handle}</p>
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
