/**
 * Organiser-side mirror of the guest invite's "is this segment empty?" logic.
 *
 * SOURCE OF TRUTH: `cire/web/src/components/invite-emptiness.ts`. The guest site
 * hides the hero / Our-Story segments when they have no content; the builder uses
 * the SAME predicates here to show a "Shown" vs "Hidden — empty" badge per
 * section, so the organiser knows exactly what a guest will see before they save.
 * The two packages share no code, so keep these byte-for-byte in lockstep.
 *
 * "Absent" means null, undefined, empty-string, OR whitespace-only.
 */

/** A value is "present" when it is a non-empty, non-whitespace-only string. */
export function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The hero is HIDDEN on the guest invite when it has no image, no title and no
 * subtitle (it would otherwise paint an empty full-screen section). Image-only or
 * title-only is shown.
 */
export function isHeroEmpty(hero: {
  imageUrl: string | null | undefined;
  title: string | null | undefined;
  subtitle: string | null | undefined;
}): boolean {
  return !hasText(hero.imageUrl) && !hasText(hero.title) && !hasText(hero.subtitle);
}

/**
 * The Our-Story section is HIDDEN when its heading, body and image are all absent.
 * (The eyebrow is a label, not content — it does not keep the section alive.)
 */
export function isStoryEmpty(story: {
  heading: string | null | undefined;
  body: string | null | undefined;
  imageUrl: string | null | undefined;
}): boolean {
  return !hasText(story.heading) && !hasText(story.body) && !hasText(story.imageUrl);
}
