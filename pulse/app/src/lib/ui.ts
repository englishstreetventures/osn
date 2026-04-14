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
 * author as a close friend of the current viewer. Used by `RsvpAvatar`
 * — when it renders a row whose `isCloseFriend` flag is true, it appends
 * these classes via `cn()`.
 *
 * Change the colour here and every close-friend affordance in the app
 * updates automatically.
 */
export const CLOSE_FRIEND_RING_CLASS = "ring-2 ring-green-500 ring-offset-2 ring-offset-card";
