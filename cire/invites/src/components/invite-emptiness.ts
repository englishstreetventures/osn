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
 * DetailsPanel's venue, run of show, guest policy, about, dress code,
 * inspiration and getting there). The organiser builder mirrors the hero,
 * story, closing and FAQ predicates and their four state functions in
 * `cire/host/src/lib/invite-emptiness.ts`, so its badges always match what a
 * guest actually sees; the organiser's events tab mirrors `hasRunOfShow` and
 * `hasGuestPolicy` there too. Keep the two copies in lockstep. The other
 * per-event predicates have no organiser twin. The switch vocabulary and
 * `sectionState` itself are shared through `@cire/theme`.
 */

import { sectionState, type SectionState } from "@cire/theme";

import { isRunOfShowItem, resolveMapsUrl } from "./event-details";
import { isSafePinterestLinkUrl } from "./pinterest";

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

/**
 * The Inspiration segment renders for a Pinterest URL the moodboard can show:
 * text that is a safe https Pinterest link. `PinterestBoard` draws nothing for
 * anything else, which would leave the label over an empty space.
 */
export function hasPinterest(pinterestUrl: string | null | undefined): boolean {
  return hasText(pinterestUrl) && isSafePinterestLinkUrl(pinterestUrl ?? "");
}

/**
 * The venue row renders when something can open a map: an address, a venue
 * name, or an organiser's http(s) maps link. The same test `MapPreview` makes
 * before it draws anything (`resolveMapsUrl`), so the row and its contents can
 * never disagree.
 */
export function hasVenue(
  address: string | null | undefined,
  mapsUrl: string | null | undefined,
  venueName?: string | null,
): boolean {
  return (
    resolveMapsUrl({
      address: address ?? null,
      mapsUrl: mapsUrl ?? null,
      venueName: venueName ?? null,
    }) !== null
  );
}

/**
 * The run of show renders when any item can be shown: a 24-hour time and a
 * label (`isRunOfShowItem`). Takes the payload as it arrived, since the claim
 * guard does not check it.
 */
export function hasRunOfShow(items: unknown): boolean {
  return Array.isArray(items) && (items as unknown[]).some(isRunOfShowItem);
}

/**
 * The guest policy has something to say with a children or plus-one preset
 * this build knows, or a note. The sheet's row also needs the household:
 * "Plus-ones welcome" is not said to one that cannot bring anyone
 * (`guestPolicyLines`), so a policy of only that and no note shows no row to
 * such a household.
 */
export function hasGuestPolicy(
  childrenPolicy: string | null | undefined,
  plusOnePolicy: string | null | undefined,
  note: string | null | undefined,
): boolean {
  return (
    childrenPolicy === "adults_only" ||
    childrenPolicy === "children_welcome" ||
    plusOnePolicy === "by_invitation" ||
    plusOnePolicy === "welcome" ||
    hasText(note)
  );
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
