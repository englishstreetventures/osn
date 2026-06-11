import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { A } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { toast } from "solid-toast";

import { Icon } from "../components/Icon";
import { type CalendarEntry, formatTimeRange } from "../lib/calendar";
import { upsertMyRsvp } from "../lib/rsvps";

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * One event on the calendar timeline. When the viewer's RSVP is "maybe",
 * an inline reminder strip prompts them to confirm (Going) or drop it
 * (Can't make it); confirming/declining calls the RSVP endpoint and asks
 * the page to refetch via `onChanged`.
 */
export function CalendarEventCard(props: {
  entry: CalendarEntry;
  accessToken: string | null;
  onChanged: () => void;
}) {
  const event = () => props.entry.event;
  const [submitting, setSubmitting] = createSignal(false);

  async function confirm(status: "going" | "not_going") {
    if (!props.accessToken) {
      toast.error("Sign in to update your RSVP");
      return;
    }
    setSubmitting(true);
    try {
      const result = await upsertMyRsvp(event().id, status, props.accessToken);
      if (!result.ok) {
        toast.error(result.error ?? "Failed to update RSVP");
        return;
      }
      toast.success(status === "going" ? "See you there!" : "RSVP updated");
      props.onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="cal-card border-border bg-card rounded-xl border">
      <A
        href={`/events/${event().id}`}
        class="hover:bg-secondary/40 block px-4 py-3 transition-colors"
      >
        <div
          class="flex items-center gap-1.5 text-[11.5px] tracking-wider uppercase"
          style={{ "font-family": "var(--font-mono)", color: "var(--pulse-accent-strong)" }}
        >
          <Icon name="clock" size={11} />
          {formatTimeRange(event().startTime, event().endTime)}
          <Show when={event().status === "ongoing"}>
            <span class="cal-live-dot" aria-hidden="true" />
            <span style={{ color: "var(--badge-live)" }}>Live</span>
          </Show>
        </div>

        <h3 class="mt-1 mb-0 line-clamp-2 text-[15.5px] leading-tight font-semibold tracking-tight">
          {event().title}
        </h3>

        <Show when={event().venue || event().location}>
          <div class="text-muted-foreground mt-1 flex items-center gap-1.5 text-[12.5px]">
            <Icon name="map-pin" size={12} />
            <span class="truncate">{event().venue ?? event().location}</span>
          </div>
        </Show>

        <div class="text-muted-foreground mt-1.5 flex items-center gap-2 text-[11.5px]">
          <Show
            when={props.entry.isHost}
            fallback={
              <Show when={event().createdByName}>
                {(name) => (
                  <span class="flex items-center gap-1.5">
                    <Avatar class="h-[18px] w-[18px]">
                      <Show when={event().createdByAvatar}>
                        {(avatar) => <AvatarImage src={avatar()} alt={name()} />}
                      </Show>
                      <AvatarFallback class="text-[8px]">{initials(name())}</AvatarFallback>
                    </Avatar>
                    Hosted by <b class="text-foreground font-semibold">{name()}</b>
                  </span>
                )}
              </Show>
            }
          >
            <span class="cal-badge cal-badge--host">You're hosting</span>
          </Show>
          <Show when={props.entry.myStatus === "going"}>
            <span class="cal-badge cal-badge--going">Going</span>
          </Show>
          <Show when={props.entry.myStatus === "maybe"}>
            <span class="cal-badge cal-badge--maybe">Maybe</span>
          </Show>
        </div>
      </A>

      {/* Reminder strip — only for unconfirmed "maybe" RSVPs. */}
      <Show when={props.entry.myStatus === "maybe"}>
        <div class="border-border bg-secondary/30 flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
          <span class="text-muted-foreground mr-auto text-[12px]">Can you make it?</span>
          <button
            type="button"
            disabled={submitting()}
            onClick={() => confirm("going")}
            class="cal-confirm cal-confirm--yes"
          >
            I'm going
          </button>
          <button
            type="button"
            disabled={submitting()}
            onClick={() => confirm("not_going")}
            class="cal-confirm cal-confirm--no"
          >
            Can't make it
          </button>
        </div>
      </Show>
    </div>
  );
}
