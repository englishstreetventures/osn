import { Schema } from "effect";

// ── Image slots ───────────────────────────────────────────────────────────────

/**
 * The fixed set of customisable image slots on the invite. Closed on purpose:
 * the builder is deliberately a few well-placed slots, not a generic
 * page-builder. This union is the single source of truth — it bounds the
 * `:slot` route param, the R2 key namespace, and (imported via `import type`)
 * the bounded span/log attributes. Adding a slot is a conscious schema change,
 * never a free-form string.
 */
export const INVITE_IMAGE_SLOTS = ["hero", "story"] as const;
export type InviteImageSlot = (typeof INVITE_IMAGE_SLOTS)[number];

export function isInviteImageSlot(value: string): value is InviteImageSlot {
  return (INVITE_IMAGE_SLOTS as readonly string[]).includes(value);
}

// ── Text customisation ────────────────────────────────────────────────────────

// A nullable, length-bounded copy field. `null` (or an all-whitespace value the
// service normalises to null) means "fall back to the built-in default". Caps
// keep a compromised/abusive organiser token from stuffing the public invite
// with unbounded text.
const copyField = (max: number) => Schema.NullOr(Schema.String.pipe(Schema.maxLength(max)));

/**
 * Full set of text overrides. The builder form always submits every field, so
 * the body is total (each key present) — a `null`/empty value clears the
 * override back to the default rather than leaving the previous value.
 */
export const InviteTextBody = Schema.Struct({
  heroTitle: copyField(120),
  heroSubtitle: copyField(200),
  storyEyebrow: copyField(80),
  storyHeading: copyField(160),
  storyBody: copyField(4000),
});
export type InviteTextBody = Schema.Schema.Type<typeof InviteTextBody>;
