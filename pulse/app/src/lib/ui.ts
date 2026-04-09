/**
 * Shared UI tokens for Pulse. Centralising visual treatments here means a
 * single-file edit can change how an affordance looks across the app.
 *
 * Prefer importing a token from here over hard-coding the same Tailwind
 * classes in multiple components. If you need to change the close-friend
 * outline colour, for example, this is the only file you should touch.
 */

/**
 * Ring classes applied to an avatar (img or initials span) to mark the
 * author as a close friend of the current viewer. Used by `RsvpSection`
 * and `RsvpModal` — when those render a row whose `isCloseFriend` flag
 * is true, they append these classes to the avatar element.
 *
 * Change the colour here and every close-friend affordance in the app
 * updates automatically.
 */
export const CLOSE_FRIEND_RING_CLASS = "ring-2 ring-green-500 ring-offset-2 ring-offset-card";

/**
 * Build the full set of avatar classes for a close-friend-aware avatar.
 * Call with `isCloseFriend: true` to append the close-friend ring.
 */
export function avatarClasses(base: string, isCloseFriend: boolean | undefined): string {
  return isCloseFriend ? `${base} ${CLOSE_FRIEND_RING_CLASS}` : base;
}
