// Arriving from the marketing site's closing field.
//
// cireweddings.com links here as `/?name=<the couple's names>` so the create
// form opens with them already typed. Anyone can write that link, so the value
// is treated as text a stranger typed: it only ever fills the field, the
// organiser submits it or not, and it is never shown anywhere else.

/** The query parameter the marketing site sets. */
export const NAME_PARAM = "name";

/**
 * C0 and C1 controls, and the characters that reorder the text around them:
 * the embeddings and overrides (U+202A–202E), the isolates (U+2066–2069) and
 * the direction marks (U+200E, U+200F, U+061C). A name never needs one, and a
 * crafted link could use them to make the field read differently from what it
 * sends.
 */
const UNWANTED = /[\p{Cc}‪-‮⁦-⁩‎‏؜]/gu;

/**
 * The name to prefill, or `null` when the query carries none worth using.
 *
 * Stripped, then trimmed, then cut to `maxLength` UTF-16 units — the unit
 * cire-api's length check counts — dropping a character rather than leaving
 * half of one.
 */
export function readNamePrefill(search: string, maxLength: number): string | null {
  const raw = new URLSearchParams(search).get(NAME_PARAM);
  if (raw === null) return null;
  let name = "";
  for (const char of raw.replace(UNWANTED, "").trim()) {
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
