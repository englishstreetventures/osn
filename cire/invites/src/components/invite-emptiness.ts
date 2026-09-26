/**
 * Which of the guest invite's conditional segments render. A segment is HIDDEN
 * when every field that could give it content is absent. "Absent" means null,
 * undefined, empty-string, OR whitespace-only — an organiser who types only
 * spaces into a field hasn't actually filled it.
 *
 * The hero, Our Story, the FAQ and the closing section also have a visibility
 * switch (`VISIBILITY_SECTIONS` in `@cire/theme`). `heroState` / `storyState` /
 * `faqState` / `footerState` combine the switch with the emptiness check: a
 * section renders only when its state is `shown` — switched on AND it has
 * content.
 *
 * These are the single source of truth for which invite segments render on the
 * guest site (InviteHeader hero + story, the packs' FAQ section, InviteClosing,
 * DetailsModal inspiration + dress code). The organiser builder mirrors the
 * content predicates and the four state functions in
 * `cire/host/src/lib/invite-emptiness.ts`, so its
 * badges always match what a guest actually sees. The switch vocabulary and
 * `sectionState` itself are shared through `@cire/theme`; the content predicates
 * are two hand-kept copies. Keep them in lockstep.
 */

import { sectionState, type SectionState } from "@cire/theme";

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

/**
 * The footer's closing note is present (so it renders above the couple's name)
 * iff it has text. There is no built-in default for this one — an organiser who
 * leaves it blank gets today's footer, couple's title over the legal links, with
 * nothing above it.
 */
export function hasFooterMessage(message: string | null | undefined): boolean {
  return hasText(message);
}

/** Footer-shaped content (the couple's closing note + their motif image). */
export interface FooterContent {
  message: string | null | undefined;
  imageUrl: string | null | undefined;
}

/**
 * The closing section is EMPTY when the couple has set neither a note nor an
 * image, and then it renders nothing at all. It is separate from the site
 * footer below it, whose legal links always render.
 *
 * The two are independent: a note with no image renders the note, an image with
 * no note renders the image.
 */
export function isFooterEmpty(footer: FooterContent): boolean {
  return !hasText(footer.message) && !hasText(footer.imageUrl);
}

/**
 * The hero's state from its switch and its content. `visible` absent (a payload
 * from an API older than the switches) reads as on — see `sectionState`.
 */
export function heroState(visible: boolean | null | undefined, hero: HeroContent): SectionState {
  return sectionState(visible, isHeroEmpty(hero));
}

/** Our Story's state from its switch and its content. */
export function storyState(visible: boolean | null | undefined, story: StoryContent): SectionState {
  return sectionState(visible, isStoryEmpty(story));
}

/** The closing section's state from its switch and its content. */
export function footerState(
  visible: boolean | null | undefined,
  footer: FooterContent,
): SectionState {
  return sectionState(visible, isFooterEmpty(footer));
}

/** One FAQ entry, as far as emptiness is concerned. */
export interface FaqContent {
  question: string | null | undefined;
  answer: string | null | undefined;
}

/**
 * The FAQ is EMPTY when no entry has both a question and an answer. The API
 * refuses a blank field, so in practice this is "has no entries"; the check
 * still holds against a malformed payload, where an entry with half its text
 * missing would otherwise paint an empty disclosure.
 */
export function isFaqEmpty(entries: readonly FaqContent[] | null | undefined): boolean {
  return !(entries ?? []).some((e) => hasText(e.question) && hasText(e.answer));
}

/** The FAQ's state from its switch and its entries. */
export function faqState(
  visible: boolean | null | undefined,
  entries: readonly FaqContent[] | null | undefined,
): SectionState {
  return sectionState(visible, isFaqEmpty(entries));
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
