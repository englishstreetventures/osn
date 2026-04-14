import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import {
  fetchLatestRsvps,
  fetchRsvpCounts,
  upsertMyRsvp,
  type Rsvp,
  type RsvpCounts,
} from "../lib/rsvps";
import { RsvpAvatar } from "./RsvpAvatar";
import { RsvpModal } from "./RsvpModal";

interface Event {
  id: string;
  guestListVisibility: "public" | "connections" | "private";
  allowInterested: boolean;
  joinPolicy: "open" | "guest_list";
  createdByProfileId: string;
}

export function RsvpSection(props: {
  event: Event;
  accessToken: string | null;
  currentProfileId: string | null;
}) {
  const tokenSource = () => ({
    eventId: props.event.id,
    token: props.accessToken,
  });
  const [latest, { refetch: refetchLatest }] = createResource(tokenSource, ({ eventId, token }) =>
    fetchLatestRsvps(eventId, token),
  );
  const [counts, { refetch: refetchCounts }] = createResource<RsvpCounts>(() =>
    fetchRsvpCounts(props.event.id),
  );
  const [submitting, setSubmitting] = createSignal(false);
  const [modalOpen, setModalOpen] = createSignal(false);

  const isOrganiser = () => props.currentProfileId === props.event.createdByProfileId;
  const isPrivateList = () => props.event.guestListVisibility === "private" && !isOrganiser();

  async function handleRsvp(status: "going" | "interested" | "not_going") {
    if (!props.accessToken) {
      toast.error("Sign in to RSVP");
      return;
    }
    setSubmitting(true);
    try {
      const result = await upsertMyRsvp(props.event.id, status, props.accessToken);
      if (!result.ok) {
        toast.error(result.error ?? "Failed to RSVP");
        return;
      }
      toast.success("RSVP updated");
      refetchLatest();
      refetchCounts();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card class="p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-foreground text-sm font-semibold">Who's going</h3>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          class="text-primary text-xs hover:underline"
        >
          See all
        </button>
      </div>

      <Show
        when={!isPrivateList()}
        fallback={
          <p class="text-muted-foreground text-xs">
            This event has a private guest list. Only the organiser can see who's going.
          </p>
        }
      >
        <Show
          when={(latest()?.length ?? 0) > 0}
          fallback={<p class="text-muted-foreground text-xs">No one's RSVPed yet.</p>}
        >
          <div class="mb-3 flex -space-x-2">
            <For each={latest()!.slice(0, 5)}>{(rsvp: Rsvp) => <RsvpAvatar rsvp={rsvp} />}</For>
          </div>
        </Show>
      </Show>

      <div class="text-muted-foreground mb-3 flex gap-3 text-xs">
        <span>{counts()?.going ?? 0} going</span>
        <Show when={props.event.allowInterested}>
          <span>{counts()?.interested ?? 0} maybe</span>
        </Show>
        <span>{counts()?.not_going ?? 0} can't make it</span>
        <Show when={props.event.joinPolicy === "guest_list"}>
          <span>{counts()?.invited ?? 0} invited</span>
        </Show>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button size="sm" disabled={submitting()} onClick={() => handleRsvp("going")}>
          I'm going
        </Button>
        <Show when={props.event.allowInterested}>
          <Button
            variant="secondary"
            size="sm"
            disabled={submitting()}
            onClick={() => handleRsvp("interested")}
          >
            Maybe
          </Button>
        </Show>
        <Button
          variant="secondary"
          size="sm"
          disabled={submitting()}
          onClick={() => handleRsvp("not_going")}
        >
          Can't make it
        </Button>
      </div>

      <Show when={modalOpen()}>
        <RsvpModal
          event={props.event}
          accessToken={props.accessToken}
          onClose={() => setModalOpen(false)}
        />
      </Show>
    </Card>
  );
}
