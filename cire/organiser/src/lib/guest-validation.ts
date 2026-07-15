// Client MIRROR of the guest-side field rules the server enforces (§6 "Client
// mirror" of [[guest-event-editor]]). The server stays AUTHORITATIVE — this
// exists only for inline, pre-submit feedback so a field-invalid draft never
// reaches `changes/preview`. Effect can't be imported in the organiser bundle,
// so the shared `cire/api/src/services/guest-event-validation.ts` predicates
// can't be reused verbatim; the small set of rules the guests editor needs is
// mirrored here, each pointing at its server source of truth.
//
// SOURCE OF TRUTH for every constant/rule below:
//   cire/api/src/services/guest-event-validation.ts  (isBlank, normaliseName)
//   cire/api/src/services/spreadsheet.ts              (MAX_CELL_LENGTH; the
//                                                       required-name checks)

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
 *  duplicate-first-name-within-a-household clash the server rejects (first name
 *  is the fallback match key). */
export function normaliseName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
