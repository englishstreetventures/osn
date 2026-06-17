import { Schema } from "effect";

/**
 * Body for `POST /api/organiser/weddings/:weddingId/hosts`. The wedding comes
 * from the route + ownership gate; the only input is the OSN handle to add as a
 * co-host. osn-api owns handle normalisation (strips `@`, lowercases), so this
 * just trims and bounds the length — a handle is ≤30 chars, plus a possible `@`,
 * so 64 is a generous ceiling that caps the query param.
 */
export const AddHostBody = Schema.Struct({
  handle: Schema.String.pipe(
    Schema.transform(Schema.String, {
      strict: true,
      decode: (s) => s.trim(),
      encode: (s) => s,
    }),
    Schema.minLength(1),
    Schema.maxLength(64),
  ),
});
export type AddHostBody = Schema.Schema.Type<typeof AddHostBody>;
