import { Show } from "solid-js";

import type { Rsvp } from "../lib/rsvps";
import { avatarClasses } from "../lib/ui";

/**
 * Shared avatar renderer for RSVP rows. Renders the user's avatar image
 * if present, falls back to initials, and applies the close-friend ring
 * (centralised in `lib/ui.ts`) when `rsvp.isCloseFriend` is true.
 *
 * Used by `RsvpSection` (the inline strip) and `RsvpModal` (the full
 * tabbed list) so a single edit changes the close-friend treatment
 * across the entire event-detail page.
 */
export function RsvpAvatar(props: { rsvp: Rsvp; size?: "sm" | "md" }) {
  const sizeClass = () => (props.size === "md" ? "w-10 h-10" : "w-8 h-8");
  const baseImg = () => `${sizeClass()} rounded-full object-cover border-2 border-card`;
  const baseInitials = () =>
    `inline-flex items-center justify-center ${sizeClass()} rounded-full bg-muted text-muted-foreground text-[10px] font-semibold border-2 border-card`;
  const label = () =>
    props.rsvp.user?.displayName ?? props.rsvp.user?.handle ?? "Anonymous attendee";

  return (
    <Show
      when={props.rsvp.user?.avatarUrl}
      fallback={
        <span
          class={avatarClasses(baseInitials(), props.rsvp.isCloseFriend)}
          title={label()}
          aria-label={label()}
        >
          {initials(label())}
        </span>
      }
    >
      {(avatar) => (
        <img
          src={avatar()}
          alt={label()}
          class={avatarClasses(baseImg(), props.rsvp.isCloseFriend)}
        />
      )}
    </Show>
  );
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
