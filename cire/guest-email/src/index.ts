/**
 * A wedding guest's email address: the one rule for what counts as one, the
 * form it is stored in, and the two wordings whose versions are stamped beside
 * it as the evidence of consent.
 *
 * Shared by the API, which is the authority, and by the organiser portal and
 * the guest invite, which check as the user types. The server never trusts a
 * client's check.
 */

/** The longest address stored (RFC 5321's path limit, less the brackets). */
export const MAX_GUEST_EMAIL_LENGTH = 254;

/** The longest local part, the text before the `@` (RFC 5321). */
const MAX_LOCAL_PART_LENGTH = 64;

/**
 * Characters that never appear in an address this product stores. Whitespace
 * and control characters, and the punctuation that separates a list
 * (`,` `;`), quotes a display name (`"`), brackets one (`<` `>` `(` `)`
 * `[` `]`) or escapes (`\`). Some are legal in a quoted local part, which no
 * guest list needs and no mail provider here accepts.
 */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const FORBIDDEN = /[\s\u0000-\u001f\u007f,;"<>()[\]\\]/u;

/**
 * The stored form of an address: surrounding space removed and lower-cased,
 * so two spellings of one address store one value. The comparison the import
 * diff makes and the suppression hash are both taken over this form.
 */
export function normaliseGuestEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether an already-normalised address is one this product will store: one
 * `@`, a local part of 1–64 characters, a domain of dot-separated non-empty
 * labels with at least one dot, nothing from {@link FORBIDDEN}, and at most
 * {@link MAX_GUEST_EMAIL_LENGTH} characters in all. Deliberately not a full
 * RFC 5322 parser: it refuses what cannot be one deliverable address.
 */
export function isValidGuestEmail(address: string): boolean {
  if (address.length > MAX_GUEST_EMAIL_LENGTH) return false;
  if (FORBIDDEN.test(address)) return false;
  // An empty string splits to one part, so it fails here too.
  const parts = address.split("@");
  if (parts.length !== 2) return false;
  // Both parts exist past the check above; the defaults only satisfy the type.
  const [local = "", domain = ""] = parts;
  if (local.length === 0 || local.length > MAX_LOCAL_PART_LENGTH) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length > 0);
}

/** The stored form of `raw` when it is a valid address, else null. */
export function parseGuestEmail(raw: string): string | null {
  const address = normaliseGuestEmail(raw);
  return isValidGuestEmail(address) ? address : null;
}

/**
 * What a guest agrees to when they give their own address on the invite, and
 * the version that names those words.
 *
 * The invite renders `text` beside the box and sends `version` with the
 * address; the API refuses an address whose version is not this one, and
 * stamps this one into `guests.email_consent_version`. So an invite and an API
 * built from different commits cannot store evidence naming words that were
 * not on screen.
 *
 * Changing `text` means changing `version` in the same commit (the test beside
 * this package pins the two together). `wiki/compliance/data-map.md` names
 * the current version and moves with it.
 */
export const GUEST_EMAIL_CONSENT = {
  /** Prefixed, so the stored value alone says whose words it names. */
  version: "guest-email-2026-10-21",
  text: "I’d like emails about this wedding from my hosts, sent through Cire to this address. I can remove it here at any time.",
} as const;

/**
 * What an organiser (an owner or editor) confirms when they add or change a
 * guest's address in the portal's guest editor or a spreadsheet, and the
 * version that names those words.
 *
 * The organiser is not the guest, so their tick is an attestation that the
 * guest agreed, given on behalf of the wedding's owners, who decide what is
 * collected ([[dpia/cire-guest-data]]). The address was not obtained from the
 * guest, so the words also commit the organiser to passing on the guest
 * privacy notice (GDPR Art. 14); the portal links the notice under the box.
 * The portal renders `text` beside the box and sends `version` with the
 * apply; the API refuses an apply that sets an address unless the version is
 * this one, and stamps it onto each address it sets.
 *
 * Changing `text` means changing `version` in the same commit.
 */
export const ORGANISER_EMAIL_ATTESTATION = {
  /** Prefixed, so the stored value alone says whose words it names. */
  version: "organiser-email-2026-10-21",
  text: "I confirm each guest whose email address I’m adding or changing agreed to get emails about this wedding, and I’ll share Cire’s guest privacy notice with them.",
} as const;
