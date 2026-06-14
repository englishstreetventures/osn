import { Schema } from "effect";

// ── Request bodies ────────────────────────────────────────────────────────────

/**
 * POST /api/account/link body. The OSN identity comes from the verified access
 * token (the `osnAuth` middleware sets `osnProfileId`); the only thing the
 * client supplies is WHICH invitee in their household to attach — the guest
 * session proves the family, this names the seat.
 */
export const LinkAccountBody = Schema.Struct({
  guestId: Schema.NonEmptyString,
});
export type LinkAccountBody = Schema.Schema.Type<typeof LinkAccountBody>;
