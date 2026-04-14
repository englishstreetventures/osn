import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarImage, AvatarFallback } from "@osn/ui/ui/avatar";
import { Show } from "solid-js";

import type { Rsvp } from "../lib/rsvps";
import { CLOSE_FRIEND_RING_CLASS } from "../lib/ui";

/**
 * Shared avatar renderer for RSVP rows. Renders the profile's avatar image
 * if present, falls back to initials, and applies the close-friend ring
 * when `rsvp.isCloseFriend` is true.
 *
 * Used by `RsvpSection` (the inline strip) and `RsvpModal` (the full
 * tabbed list) so a single edit changes the close-friend treatment
 * across the entire event-detail page.
 */
export function RsvpAvatar(props: { rsvp: Rsvp; size?: "sm" | "md" }) {
  const sizeClass = () => (props.size === "md" ? "w-10 h-10" : "w-8 h-8");
  const label = () =>
    props.rsvp.profile?.displayName ?? props.rsvp.profile?.handle ?? "Anonymous attendee";

  return (
    <Avatar
      class={clsx(
        sizeClass(),
        "border-2 border-card",
        props.rsvp.isCloseFriend && CLOSE_FRIEND_RING_CLASS,
      )}
      title={label()}
      aria-label={label()}
    >
      <Show when={props.rsvp.profile?.avatarUrl}>
        {(avatar) => <AvatarImage src={avatar()} alt={label()} />}
      </Show>
      <AvatarFallback>{initials(label())}</AvatarFallback>
    </Avatar>
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
