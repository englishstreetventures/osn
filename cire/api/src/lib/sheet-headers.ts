/**
 * Canonical column labels for the organiser events + guests sheets — the ONE
 * place the header vocabulary lives on the API side. Consumed by the parser
 * (`services/spreadsheet.ts`) and the round-trip state exporter
 * (`services/state-export.ts`), so the sheets the exporter writes are by
 * construction the sheets the parser reads.
 *
 * LOCKSTEP: `cire/organiser/src/lib/import-templates.ts` mirrors these labels
 * for the browser-generated starter templates (it cannot import this module —
 * the organiser app must not depend on `@cire/api`). Both sides pin the exact
 * strings in tests (`state-export.test.ts` here, `import-templates.test.ts`
 * there); a rename on either side fails one of them.
 */

/** Required event columns, in template order — the minimum to render and order
 *  an event on the invite. */
export const EVENT_SHEET_REQUIRED_HEADERS = ["Event Name", "Start", "Timezone"] as const;

/** Optional event columns, in template order. `End` may be blank (open-ended
 *  event, the `""` sentinel); `Location` is a venue name that only fills in for
 *  a blank `Address` at import-write time. */
export const EVENT_SHEET_OPTIONAL_HEADERS = [
  "End",
  "Location",
  "Address",
  "Dress Code Description",
  "Dress Code Palette",
  "Pinterest URL",
  "Maps URL",
] as const;

/** Full events header row = required, then optional. */
export const EVENT_SHEET_HEADERS = [
  ...EVENT_SHEET_REQUIRED_HEADERS,
  ...EVENT_SHEET_OPTIONAL_HEADERS,
] as const;

/** The four fixed guest columns every guests sheet must start with. `Family ID`
 *  is a grouping key the parser does not interpret (grouping is by Family
 *  Name); the standard export writes sequential `fam-001` style values there,
 *  the full-fidelity export writes the internal family id. */
export const GUEST_SHEET_FIXED_HEADERS = [
  "Family ID",
  "Family Name",
  "Guest First Name",
  "Guest Last Name",
] as const;

/** Optional informal name for the single-guest greeting. */
export const GUEST_NICKNAME_HEADER = "Guest Nickname";

// ── Fidelity columns ─────────────────────────────────────────────────────────
// Appended by the full-fidelity export (`?fidelity=full`) and by the E3
// checkpoint writer so a snapshot restores ids + claim codes exactly. The
// parser treats them as fixed (non-event) columns and otherwise IGNORES them
// today; the E2 ID-aware diff starts honouring them. See
// [[guest-event-editor]] §4–§5.

/** Internal event id (events sheet, full fidelity). */
export const EVENT_ID_HEADER = "Event ID";
/** Internal guest id (guests sheet, full fidelity). */
export const GUEST_ID_HEADER = "Guest ID";
/** The family's claim code / `publicId` (guests sheet, full fidelity) — a
 *  full-fidelity download contains live invite credentials. */
export const FAMILY_CODE_HEADER = "Family Code";
