/**
 * Shared "is this content absent?" predicates for the guest invite's conditional
 * segments. A segment is HIDDEN when every field that could give it content is
 * absent. "Absent" means null, undefined, empty-string, OR whitespace-only — an
 * organiser who types only spaces into a field hasn't actually filled it.
 *
 * These predicates are the single source of truth for which invite segments
 * render on the guest site (InviteHeader hero + story, DetailsModal inspiration +
 * dress code). The organiser builder mirrors the SAME logic (see
 * `cire/organiser/src/lib/invite-emptiness.ts`) so its "Shown / Hidden — empty"
 * badges always match what a guest actually sees. Keep the two in lockstep.
 */

/** A value is "present" when it is a non-empty, non-whitespace-only string. */
export function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Hero hero-shaped content (image + couple title + subtitle). */
export interface HeroContent {
  imageUrl: string | null | undefined;
  title: string | null | undefined;
  subtitle: string | null | undefined;
}

/**
 * The hero renders when it has an image OR a title OR a subtitle. A hero with no
 * image, no title and no subtitle would paint an empty full-screen section, so we
 * hide it entirely. (Image-only or title-only is valid — see spec.)
 */
export function isHeroEmpty(hero: HeroContent): boolean {
  return !hasText(hero.imageUrl) && !hasText(hero.title) && !hasText(hero.subtitle);
}

/** Our-Story-shaped content (heading + body + story image). */
export interface StoryContent {
  heading: string | null | undefined;
  body: string | null | undefined;
  imageUrl: string | null | undefined;
}

/**
 * The story renders when it has a heading OR a body OR an image. With all three
 * absent there is nothing to say, so we hide the section rather than show the
 * built-in default copy over an empty surface. (The eyebrow alone is a label, not
 * content — it does not keep the section alive.)
 */
export function isStoryEmpty(story: StoryContent): boolean {
  return !hasText(story.heading) && !hasText(story.body) && !hasText(story.imageUrl);
}

/** A pinterest URL is present (so the Inspiration segment renders) iff it has text. */
export function hasPinterest(pinterestUrl: string | null | undefined): boolean {
  return hasText(pinterestUrl);
}

/**
 * A dress code is present (so the Dress Code segment renders) when there is a
 * description OR at least one palette swatch. An empty description and an empty /
 * null palette mean there is no dress code to show.
 */
export function hasDressCode(
  dressCodeDescription: string | null | undefined,
  dressCodePalette: readonly unknown[] | null | undefined,
): boolean {
  return hasText(dressCodeDescription) || (dressCodePalette?.length ?? 0) > 0;
}
