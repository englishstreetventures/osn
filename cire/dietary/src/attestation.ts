/**
 * What a household confirms when it gives a plus-one's dietary requirements,
 * and the version that names those words.
 *
 * A plus-one never holds the household's code and never sees the invite, so
 * the household's tick for them is not the plus-one's own consent: it is the
 * household's confirmation that the plus-one agreed (GDPR Art. 9(2)(a), the
 * inviter-attested variant in `wiki/compliance/dpia/cire-guest-data.md`).
 *
 * The words and the version live in one constant, in the one package both
 * sides already share. The guest invite renders `text` beside the box and
 * sends `version` with the reply; the API refuses a plus-one's dietary data
 * unless the version sent is this one, and stamps this one onto the row. So a
 * guest site and an API built from different commits cannot store evidence
 * naming words that were not on screen: a mismatch is refused.
 *
 * Changing `text` means changing `version` in the same commit (the test beside
 * this file pins the two together). `wiki/compliance/data-map.md` names the
 * current version on the consent-record row and moves with it.
 */
export const PLUS_ONE_DIETARY_ATTESTATION = {
  /**
   * Stamped into `rsvps.dietary_consent_version` on a plus-one's attested
   * reply. Prefixed so it can never equal the guest's own-consent version, a
   * bare date: the stored value alone says which copy it names.
   */
  version: "inviter-2026-09-27",
  /** The sentence beside the box. `names` is every plus-one it covers,
   *  already joined ("Sam", "Sam and Alex"). */
  text: (names: string): string =>
    `I confirm that ${names} agreed to their dietary requirements above being stored and shared with the caterers for this wedding.`,
} as const;
