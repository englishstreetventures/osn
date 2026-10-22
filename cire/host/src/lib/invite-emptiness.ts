/**
 * Organiser-side mirror of the guest invite's "does this segment render?" logic.
 *
 * SOURCE OF TRUTH: `cire/invites/src/components/invite-emptiness.ts`. The guest
 * site renders the hero, Our Story, the FAQ and the closing section only when
 * the section's visibility switch is on AND it has content; the builder uses the SAME
 * logic here for its per-section badge ("Shown", "Hidden — empty", "Hidden —
 * switched off"), so the organiser knows exactly what a guest will see before
 * they save.
 *
 * The switch vocabulary and `sectionState` come from `@cire/theme`, which both
 * packages import. The content predicates below are a hand-kept copy of the
 * guest module's; keep the two in lockstep.
 *
 * "Absent" means null, undefined, empty-string, OR whitespace-only.
 */

import { sectionState, type SectionState } from "@cire/theme";

/** A value is "present" when it is a non-empty, non-whitespace-only string. */
export function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The hero is EMPTY when it has no image, no title and no subtitle (it would
 * otherwise paint an empty full-screen section). Image-only or title-only is
 * content.
 */
export function isHeroEmpty(hero: {
  imageUrl: string | null | undefined;
  title: string | null | undefined;
  subtitle: string | null | undefined;
}): boolean {
  return !hasText(hero.imageUrl) && !hasText(hero.title) && !hasText(hero.subtitle);
}

/**
 * The closing section is EMPTY with neither a note nor an image, and then it
 * renders nothing. The site footer below it, with the legal links, is separate
 * and always renders.
 */
export function isFooterEmpty(footer: {
  message: string | null | undefined;
  imageUrl: string | null | undefined;
}): boolean {
  return !hasText(footer.message) && !hasText(footer.imageUrl);
}

/**
 * The Our-Story section is EMPTY when its heading, body and image are all absent.
 * (The eyebrow is a label, not content — it does not keep the section alive.)
 */
export function isStoryEmpty(story: {
  heading: string | null | undefined;
  body: string | null | undefined;
  imageUrl: string | null | undefined;
}): boolean {
  return !hasText(story.heading) && !hasText(story.body) && !hasText(story.imageUrl);
}

/** The hero's state from its switch and its content. */
export function heroState(
  visible: boolean | null | undefined,
  hero: Parameters<typeof isHeroEmpty>[0],
): SectionState {
  return sectionState(visible, isHeroEmpty(hero));
}

/** Our Story's state from its switch and its content. */
export function storyState(
  visible: boolean | null | undefined,
  story: Parameters<typeof isStoryEmpty>[0],
): SectionState {
  return sectionState(visible, isStoryEmpty(story));
}

/** The closing section's state from its switch and its content. */
export function footerState(
  visible: boolean | null | undefined,
  footer: Parameters<typeof isFooterEmpty>[0],
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
 * matches the guest site's, which also has to cope with a malformed payload.
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

// ── The per-event blocks of the guest's details sheet ─────────────────────────
// Twins of the guest module's run-of-show and guest-policy predicates, so the
// organiser's events tab shows a block exactly when the guest's sheet would.
// The guest site also hides "Plus-ones welcome" from a household with no
// plus-one permission, which needs a household and so has no twin here.

/** A 24-hour `HH:MM` clock time. */
const CLOCK_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** One run-of-show item, as far as emptiness is concerned. */
export interface RunOfShowContent {
  time: string;
  label: string;
}

/** The run of show renders when any item has both a 24-hour time and a label. */
export function hasRunOfShow(items: readonly RunOfShowContent[] | null | undefined): boolean {
  return (items ?? []).some((item) => CLOCK_TIME_RE.test(item.time) && hasText(item.label));
}

/**
 * The guest policy row renders with a children or plus-one preset the guest
 * site knows, or a note.
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
