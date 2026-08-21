import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { toast } from "@shared/toast";
import { createResource, createSignal, For, Show } from "solid-js";

import {
  fetchLatestRsvps,
  fetchRsvpCounts,
  upsertMyRsvp,
  type Rsvp,
  type RsvpCounts,
} from "../lib/rsvps";
import type { ShareSource } from "../lib/shareSource";
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
  currentProfileId: string | null;
  /**
   * Inbound `?source=` value latched from the URL on this mount. Sent
   * through on the next RSVP POST and then cleared via
   * `onSourceConsumed` so subsequent status changes don't re-attribute.
   */
  inboundSource?: ShareSource | null;
  onSourceConsumed?: () => void;
}) {
  // Keyed on the viewer, not a credential: the session cookie rides along on
  // its own, but who is signed in still decides what the server returns, so a
  // sign-in or sign-out has to reload the list.
  const viewerSource = () => ({
    eventId: props.event.id,
    profileId: props.currentProfileId,
  });
  const [latest, { refetch: refetchLatest }] = createResource(viewerSource, ({ eventId }) =>
    fetchLatestRsvps(eventId),
  );
  const [counts, { refetch: refetchCounts }] = createResource<RsvpCounts>(() =>
    fetchRsvpCounts(props.event.id),
  );
  const [submitting, setSubmitting] = createSignal(false);
  const [modalOpen, setModalOpen] = createSignal(false);

  const isOrganiser = () => props.currentProfileId === props.event.createdByProfileId;
  const isPrivateList = () => props.event.guestListVisibility === "private" && !isOrganiser();

  async function handleRsvp(status: "going" | "maybe" | "not_going") {
    if (!props.currentProfileId) {
      toast.error("Sign in to RSVP");
      return;
    }
    setSubmitting(true);
    const sourceForThisCall = props.inboundSource ?? null;
    try {
      const result = await upsertMyRsvp(props.event.id, status, sourceForThisCall);
      if (!result.ok) {
        toast.error(result.error ?? "Failed to RSVP");
        return;
      }
      // Clear the latched source the moment a sourced RSVP succeeds —
      // subsequent status flips (going → not_going, etc.) shouldn't
      // re-attribute. The parent owns the latch so it can also clear
      // the URL when it wants to.
      if (sourceForThisCall) props.onSourceConsumed?.();
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
          <span>{counts()?.maybe ?? 0} maybe</span>
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
            onClick={() => handleRsvp("maybe")}
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
          currentProfileId={props.currentProfileId}
          onClose={() => setModalOpen(false)}
        />
      </Show>
    </Card>
  );
}
