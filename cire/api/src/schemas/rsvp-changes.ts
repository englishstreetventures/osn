import { Schema } from "effect";

/**
 * `POST …/rsvp-changes/seen` — the newest change the organiser was shown. The
 * service clamps it to the wedding's newest change, so the bound here only
 * keeps the value an ordinary safe integer.
 */
export const MarkRsvpChangesSeenBody = Schema.Struct({
  seq: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type MarkRsvpChangesSeenBody = Schema.Schema.Type<typeof MarkRsvpChangesSeenBody>;

/** `PUT …/rsvp-changes/digest` — the caller's own daily email, on or off. */
export const RsvpDigestBody = Schema.Struct({ enabled: Schema.Boolean });
export type RsvpDigestBody = Schema.Schema.Type<typeof RsvpDigestBody>;
