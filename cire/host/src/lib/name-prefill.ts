// Arriving from the marketing site's closing field.
//
// cireweddings.com links here as `/?name=<the couple's names>` so the create
// form opens with them already typed. Anyone can write that link, so the value
// is treated as text a stranger typed: it only ever fills the field, the
// organiser submits it or not, and it is never shown anywhere else.

/** The query parameter the marketing site sets. */
export const NAME_PARAM = "name";

/**
 * Characters a name never needs, which a crafted link could use to hide text
 * in the field or make it read differently from what it sends. Removed:
 *
 * - the C0 and C1 controls, except tab, line feed, vertical tab, form feed and
 *   carriage return, which `SPACES` turns into a space instead;
 * - the characters that reorder the text around them: the embeddings and
 *   overrides (U+202A–202E), the isolates (U+2066–2069) and the direction
 *   marks (U+200E, U+200F, U+061C);
 * - characters that draw nothing: the soft hyphen (U+00AD), the Mongolian
 *   vowel separator (U+180E), the zero-width space (U+200B), the word joiner
 *   and invisible operators (U+2060–2064), the byte-order mark (U+FEFF), the
 *   interlinear annotation marks (U+FFF9–FFFB) and the tag characters
 *   (U+E0000–E007F). A subdivision flag such as England's is built from tag
 *   characters, so in a prefilled name it shows as a plain black flag; the
 *   field takes anything the organiser types.
 *
 * The zero-width joiner and non-joiner (U+200D, U+200C) stay: the joiner
 * builds emoji sequences such as a couple, and the non-joiner spells Persian
 * and Indic names. So do letters that draw as blank space, such as the Hangul
 * filler (U+3164); no character class removes those without refusing real
 * names, so the organiser reading the field before pressing "Create wedding"
 * is still what catches a name that is not theirs.
 *
 * Built from a string of escapes rather than a regex literal: the formatter
 * writes a literal's `\u` escapes out as the characters themselves, and a
 * direction override typed into source is invisible and reorders the line.
 */
const UNWANTED = new RegExp(
  "[\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\u009f" +
    "\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c" +
    "\\u00ad\\u180e\\u200b\\u2060-\\u2064\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]",
  "gu",
);

/**
 * Every run of whitespace, Unicode spaces and line breaks included. Each run
 * becomes one space, so a name padded to push a tail past the field's edge
 * shows that tail beside the names. Applied after `UNWANTED`: the byte-order
 * mark counts as whitespace here, and it is removed, not turned into a space.
 */
const SPACES = /\s+/gu;

/**
 * The name to prefill, or `null` when the query carries none worth using.
 *
 * Stripped, then each run of whitespace made one space, then trimmed, then cut
 * to `maxLength` UTF-16 units — the unit cire-api's length check counts —
 * dropping a character rather than leaving half of one.
 */
export function readNamePrefill(search: string, maxLength: number): string | null {
  const raw = new URLSearchParams(search).get(NAME_PARAM);
  if (raw === null) return null;
  let name = "";
  for (const char of raw.replace(UNWANTED, "").replace(SPACES, " ").trim()) {
    if (name.length + char.length > maxLength) break;
    name += char;
  }
  name = name.trimEnd();
  return name.length > 0 ? name : null;
}

/**
 * The URL without the name, everything else kept.
 *
 * Required, not tidiness: `OrganiserApp` rebuilds the URL as
 * `pathname + search + hash` on every hash write, so a name left in the query
 * would fill the form again on every reload and every later wedding.
 */
export function clearNamePrefill(url: URL): string {
  const next = new URL(url.href);
  next.searchParams.delete(NAME_PARAM);
  return `${next.pathname}${next.search}${next.hash}`;
}
