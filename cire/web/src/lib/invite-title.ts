/**
 * The guest page `<title>`: the couple's hero title when they've set one
 * (e.g. "Anita & Ben — You're Invited"), the built-in default otherwise.
 * Pure so `InviteDocument.astro` stays a one-line call and both branches are
 * unit-testable without an Astro harness (T-M1).
 */
export function inviteTitle(heroTitle: string | null | undefined): string {
  return heroTitle ? `${heroTitle} — You're Invited` : "You're Invited";
}
