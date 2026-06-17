import { Schema } from "effect";

import { MAX_DISPLAY_NAME } from "../services/weddings";

/**
 * Body for `POST /api/organiser/weddings`. The owner is taken from the verified
 * OSN token upstream — never from the request — so the only input is the human
 * display name. Trimmed, non-empty, length-capped to keep the slug + UI bounded.
 */
export const CreateWeddingBody = Schema.Struct({
  displayName: Schema.String.pipe(
    Schema.transform(Schema.String, {
      strict: true,
      decode: (s) => s.trim(),
      encode: (s) => s,
    }),
    Schema.minLength(1),
    Schema.maxLength(MAX_DISPLAY_NAME),
  ),
});
export type CreateWeddingBody = Schema.Schema.Type<typeof CreateWeddingBody>;
