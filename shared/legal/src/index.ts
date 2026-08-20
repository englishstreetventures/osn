/**
 * The identity of the operator, as every published legal page must state it.
 *
 * ## Why this is a package and not eight copies
 *
 * Each privacy notice and terms page used to carry its own `{{LEGAL_ENTITY}}`,
 * `{{CONTACT_EMAIL}}`, `{{POSTAL_ADDRESS}}` and `{{REGULATOR}}` placeholder,
 * plus a hand-written "Draft — replace every highlighted value" banner. Eight
 * pages, all of them served in production with the placeholders and the banner
 * still in them, because filling them in meant eight coordinated edits and
 * nobody had the values to hand.
 *
 * Now there is one file. Fill in the four fields below and every page resolves
 * at once — and the draft banner disappears on its own, because
 * `LEGAL_DETAILS_PENDING` is derived from the values rather than hand-maintained.
 * A page cannot be left half-published.
 *
 * ## What may live here
 *
 * Only what a published legal page must already say out loud: the operating
 * entity's name, its service address, its privacy contact and its regulator.
 * Naming the controller is a GDPR Art. 13(1)(a) / APP 1.4 requirement, so none
 * of it is confidential once a notice is live.
 *
 * Nothing else. Company numbers, tax registrations, banking details and
 * commercial terms are not required on a notice and do not belong in the repo.
 */
export interface LegalEntity {
  /** Registered name, plus any trading name, exactly as it should be published. */
  readonly name: string;
  /** Service address for legal notices — a postal address, not a PO box alone. */
  readonly postalAddress: string;
  /** Where a person exercises their rights. Must be monitored by a human. */
  readonly contactEmail: string;
  /**
   * The supervisory authority a complaint goes to, named so a reader does not
   * have to find it. Australia's is the Office of the Australian Information
   * Commissioner; readers elsewhere are pointed at their own in the page copy.
   */
  readonly regulator: string;
  /**
   * Governing law, at country level. Deliberately not a state or territory:
   * the law that actually decides a dispute with a guest or an organiser here
   * is federal — the Australian Consumer Law and the Privacy Act 1988 (Cth) —
   * and a consumer keeps the protections of where they live regardless of what
   * a clause says.
   */
  readonly governingLaw: string;
  /**
   * The merchant of record for paid add-ons — the party a buyer's contract of
   * sale is actually with, which the terms and the refund policy must name.
   * Unset while nothing is for sale. Only the published name belongs here; the
   * commercial arrangement behind it does not go in the repo.
   */
  readonly merchantOfRecord: string;
  /**
   * How long account data is kept, in one publishable sentence.
   *
   * Two things this is NOT. It is not guest data: that window is 365 days after
   * the final event, enforced by `RETENTION_AFTER_FINAL_EVENT_MS` in
   * `cire/api/src/services/retention.ts` and stated as a fact on the notices —
   * a retention promise that can drift from the scheduler enforcing it is worse
   * than no promise. And it is not a marketing site's server logs, which have
   * their own answer; those notices say what their host keeps rather than
   * borrowing this.
   */
  readonly accountDataRetention: string;
}

/**
 * PLACEHOLDER VALUES. Replace all four before the pages are treated as
 * published — see `LEGAL_DETAILS_PENDING`, which every page reads to decide
 * whether to show its draft banner.
 */
export const LEGAL_ENTITY: LegalEntity = {
  name: "{{LEGAL_ENTITY}}",
  postalAddress: "{{POSTAL_ADDRESS}}",
  contactEmail: "{{CONTACT_EMAIL}}",
  regulator: "Office of the Australian Information Commissioner (OAIC)",
  governingLaw: "Australia",
  merchantOfRecord: "{{MERCHANT_OF_RECORD}}",
  accountDataRetention: "{{RETENTION}}",
};

/** A field still holding its `{{PLACEHOLDER}}` token. */
export function isPlaceholder(value: string): boolean {
  return value.startsWith("{{") && value.endsWith("}}");
}

/**
 * The fields every legal page renders, whatever else it says. The draft banner
 * derives from these alone.
 *
 * Deliberately NOT `merchantOfRecord`: it is unset while nothing is for sale,
 * which is the expected steady state, and only three of eleven pages mention a
 * purchase at all. Deriving the banner from it would leave the identity app's
 * privacy notice flagged draft over a field it never renders.
 */
const IDENTITY_FIELDS = [
  LEGAL_ENTITY.name,
  LEGAL_ENTITY.postalAddress,
  LEGAL_ENTITY.contactEmail,
] as const;

/**
 * True while any field every page renders is unfilled. Drives the draft banner,
 * so the banner cannot outlive the placeholders or vice versa.
 */
export const LEGAL_DETAILS_PENDING: boolean = IDENTITY_FIELDS.some(isPlaceholder);

/**
 * Per-field pendingness, for a page that renders something outside the identity
 * set — a purchase page naming the merchant of record, say. `LEGAL_DETAILS_PENDING`
 * will not cover it, and a page that renders `{{MERCHANT_OF_RECORD}}` without
 * flagging itself is exactly what this module exists to prevent.
 */
export function pendingAny(...values: readonly string[]): boolean {
  return values.some(isPlaceholder);
}
