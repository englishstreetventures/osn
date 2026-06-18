import { Schema } from "effect";

import { MAX_DISPLAY_NAME } from "../services/weddings";

/**
 * Claim-code tier (mirrors `weddings.code_style`). Validated server-side against
 * this exact two-value union, so a body carrying anything else (or a non-string)
 * fails decode → the route's 400, never an unexpected style reaching the DB.
 *  - `simple` — 6-char hash, shorter friendlier codes.
 *  - `secure` — 10-char hash, harder to guess (default).
 */
export const CodeStyle = Schema.Literal("simple", "secure");
export type CodeStyle = Schema.Schema.Type<typeof CodeStyle>;

/**
 * Body for `POST /api/organiser/weddings`. The owner is taken from the verified
 * OSN token upstream — never from the request — so the only inputs are the human
 * display name (trimmed, non-empty, length-capped) and an optional claim-code
 * `codeStyle` (default `secure` applied in the service when omitted).
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
  codeStyle: Schema.optional(CodeStyle),
});
export type CreateWeddingBody = Schema.Schema.Type<typeof CreateWeddingBody>;

/**
 * Body for `POST /api/organiser/weddings/:weddingId/remint`. The only input is
 * the target `codeStyle` — the wedding + caller come from the path + verified
 * token. Reminting rotates every guest family's claim code onto this style.
 */
export const RemintBody = Schema.Struct({
  codeStyle: CodeStyle,
});
export type RemintBody = Schema.Schema.Type<typeof RemintBody>;
