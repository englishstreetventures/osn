// Client MIRROR of the guest- AND event-side field rules the server enforces
// (§6 "Client mirror" of [[guest-event-editor]]). The server stays
// AUTHORITATIVE — this exists only for inline, pre-submit feedback so a
// field-invalid draft never reaches `changes/preview`. Effect can't be imported
// in the organiser bundle, so the shared
// `cire/api/src/services/guest-event-validation.ts` predicates can't be reused
// verbatim; the set of rules the guests + events editors need is mirrored here,
// each pointing at its server source of truth.
//
// SOURCE OF TRUTH for every constant/rule below:
//   cire/api/src/services/guest-event-validation.ts  (isBlank, normaliseName,
//                                                       isIsoTimestamp,
//                                                       parseHttpUrl)
//   cire/api/src/services/spreadsheet.ts              (MAX_CELL_LENGTH; the
//                                                       required-name + event
//                                                       field checks)
//   cire/theme (isSafeCssColor)                        (the palette colour
//                                                       allow-list)

import { isSafeCssColor } from "@cire/theme";

/** Mirror of spreadsheet.ts `MAX_CELL_LENGTH` — the server rejects any single
 *  field longer than this. The one hard length bound guests actually hit; there
 *  are no tighter per-field name bounds server-side, so the client must not
 *  invent stricter ones (they'd block a draft the server would accept). */
export const MAX_CELL_LENGTH = 10_000;

/** Mirror of guest-event-validation.ts `isBlank`: a required name is present iff
 *  its TRIMMED value is non-empty (leading/trailing whitespace is not a value). */
export function isBlankName(value: string): boolean {
  return value.trim().length === 0;
}

/** Mirror of guest-event-validation.ts `normaliseName`: the one canonical
 *  "same name" spelling — case + inner-whitespace folded. Used to detect the
 *  duplicate-first-name-within-a-household clash (guests) AND the
 *  duplicate-event-name clash (events) the server rejects. First name is the
 *  guest fallback match key; event name is the event fallback match key. */
export function normaliseName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// ── Event field rules (mirror spreadsheet.ts / guest-event-validation.ts) ─────

/** Mirror of guest-event-validation.ts `isIsoTimestamp`: a Start/End cell is a
 *  zero-padded `YYYY-MM-DDTHH:MM` prefix AND parseable by `Date`. The prefix
 *  shape is load-bearing (the retention sweep sorts lexically on it), so the
 *  editor must reject a free-text date exactly as the sheet path does. The
 *  editor's date+time+offset composer always produces this shape, but a
 *  hand-editable timezone/offset means we still validate. */
export function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(new Date(value).getTime());
}

/** Mirror of guest-event-validation.ts `parseHttpUrl` reduced to a predicate:
 *  a present URL must parse AND use the http(s) scheme (a `javascript:` href
 *  would otherwise reach the organiser UI and XSS). Blank ⇒ valid (the field is
 *  optional). The server rejects a non-http(s) value; so does this. */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** A palette swatch's colour must be on the shared CSS-colour allow-list
 *  (`@cire/theme.isSafeCssColor`) — the SAME validator `@cire/api`
 *  (`schemas/invite.ts`) rejects un-listed values with at write time. The
 *  ColorPicker only ever emits `#rrggbb`, so this is defence-in-depth, but it
 *  keeps the client mirror honest against the allow-list rather than inventing
 *  a looser hex-only rule. */
export function isPaletteColorSafe(value: string): boolean {
  return isSafeCssColor(value);
}
