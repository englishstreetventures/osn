import { Schema } from "effect";

/** Max household (family) name length accepted from the organiser portal —
 *  matches the display-name ceiling used elsewhere for a household label. */
export const MAX_FAMILY_NAME = 120;

/**
 * Body for `POST /api/organiser/weddings/:weddingId/households` — create a
 * CODE-LESS household (platform Phase 0 PR 4). The wedding + caller come from the
 * path + verified token; the only input is the household's display name (trimmed,
 * non-empty, length-capped). No `publicId` is accepted — a manually-created
 * household starts code-less and gets a code later via "issue invite".
 */
export const CreateHouseholdBody = Schema.Struct({
  familyName: Schema.String.pipe(
    Schema.transform(Schema.String, {
      strict: true,
      decode: (s) => s.trim(),
      encode: (s) => s,
    }),
    Schema.minLength(1),
    Schema.maxLength(MAX_FAMILY_NAME),
  ),
});
export type CreateHouseholdBody = Schema.Schema.Type<typeof CreateHouseholdBody>;
