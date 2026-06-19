/**
 * Client-side CSV starter-template generator for the organiser import.
 *
 * SOURCE OF TRUTH: `cire/api/src/services/spreadsheet.ts`. The header labels
 * and truthy-cell convention below MUST stay byte-for-byte in lockstep with the
 * parser there — a rename on either side is caught by `import-templates.test.ts`.
 * Keep this list ordered required-first, then optional, matching the parser's
 * `REQUIRED_EVENT_COLUMNS` / `REQUIRED_GUEST_COLUMNS` + optional lookups.
 *
 * Templates are generated entirely in the browser (no server, no hosted asset)
 * so the headers can never drift from the code that consumes them, and there is
 * no formula-injection surface: every cell here is a static, code-authored
 * literal — no user-supplied data is ever interpolated.
 */

/**
 * Required event columns, in parser order. MUST match `REQUIRED_EVENT_COLUMNS`
 * in `cire/api/src/services/spreadsheet.ts` — Location is required because an
 * event needs a place (it drives the invite's "Where" + Open-in-Maps).
 */
export const EVENT_REQUIRED_HEADERS = [
  "Event Name",
  "Start",
  "End",
  "Timezone",
  "Location",
] as const;

/** Optional event columns, exact labels the parser looks up. */
export const EVENT_OPTIONAL_HEADERS = [
  "Address",
  "Dress Code Description",
  "Dress Code Palette",
  "Pinterest URL",
  "Maps URL",
] as const;

/** Full events header row = required, then optional. */
export const EVENT_TEMPLATE_HEADERS = [
  ...EVENT_REQUIRED_HEADERS,
  ...EVENT_OPTIONAL_HEADERS,
] as const;

/** The four fixed guest columns every guests sheet must start with. */
export const GUEST_TEMPLATE_FIXED_HEADERS = [
  "Family ID",
  "Family Name",
  "Guest First Name",
  "Guest Last Name",
] as const;

/**
 * Placeholder event columns in the guests template. The organiser MUST rename
 * these to match their real event names (the parser matches each guest event
 * column against an already-imported event, case/space-insensitively).
 */
export const GUEST_TEMPLATE_EXAMPLE_EVENTS = ["Ceremony", "Reception"] as const;

/** Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180). */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Join a 2D array into a CRLF-terminated CSV string (RFC 4180 line endings). */
function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

/**
 * Events starter CSV: header row + two illustrative rows showing the ISO-8601
 * offset Start/End, an IANA Timezone, a quoted multi-part Address, and the
 * `Name:#hex|Name:#hex` dress-code palette format the parser splits on.
 */
export function buildEventsTemplateCsv(): string {
  const rows: string[][] = [
    [...EVENT_TEMPLATE_HEADERS],
    [
      "Ceremony",
      "2026-11-14T15:00:00+11:00",
      "2026-11-14T16:00:00+11:00",
      "Australia/Sydney",
      "St Mary's Cathedral",
      "St Marys Rd, Sydney NSW 2000, Australia",
      "Formal — suits and cocktail dresses",
      "Blush:#f4c2c2|Sage:#b2ac88",
      "https://pinterest.com/example/ceremony",
      "https://maps.google.com/?q=St+Marys+Cathedral+Sydney",
    ],
    [
      "Reception",
      "2026-11-14T18:00:00+11:00",
      "2026-11-14T23:30:00+11:00",
      "Australia/Sydney",
      "The Grounds of Alexandria",
      "7A/2 Huntley St, Alexandria NSW 2015, Australia",
      "Black tie",
      "Midnight:#191970|Gold:#d4af37",
      "https://pinterest.com/example/reception",
      "https://maps.google.com/?q=The+Grounds+of+Alexandria",
    ],
  ];
  return toCsv(rows);
}

/**
 * Guests starter CSV: the four fixed columns + one placeholder column per
 * example event. Two guests share a Family ID (so they group into one
 * household), and a parser-truthy `x` marks invitations.
 */
export function buildGuestsTemplateCsv(): string {
  const rows: string[][] = [
    [...GUEST_TEMPLATE_FIXED_HEADERS, ...GUEST_TEMPLATE_EXAMPLE_EVENTS],
    // Two guests, same Family ID → one household.
    ["fam-001", "Nguyen", "An", "Nguyen", "x", "x"],
    ["fam-001", "Nguyen", "Binh", "Nguyen", "x", ""],
    // A second household, invited to the reception only.
    ["fam-002", "Okafor", "Chidi", "Okafor", "", "yes"],
  ];
  return toCsv(rows);
}
