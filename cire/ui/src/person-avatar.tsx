import { Avatar, AvatarImage } from "@shared/ui/ui/avatar";
import { createSignal, Show } from "solid-js";

/**
 * A person's photo, or their stand-in when there is none or it will not load:
 * the portals' faces on a task and their account triggers, and the guest
 * site's account card.
 *
 * ## Two stand-ins, chosen by what the face is for
 *
 * - **`blank`** — a face in a stack or a list of people: the empty avatar, a
 *   person's figure in the page's own colour cut from a disc of faint ink laid
 *   over that colour, so it is opaque where faces overlap and reads as nobody's
 *   photo in either ramp. Never initials: on a stack, letters read as a list of
 *   codes. No frame.
 * - **`initial`** — an account's own circle: the first letter of `name`, in
 *   readable gold (`--ui-accent-ink`; gold text is never the metal gold), in
 *   the display face at weight 600, sized at half the circle's inside width
 *   (`50cqi`, so 17px in a 36px circle and 19px in a 40px one), on the surface
 *   at 40% inside a hairline circle (owner, Stack 6 questions 38 A and 39 B).
 *   The circle is the account avatar's, so a photo sits inside it too; inside
 *   `avatarTriggerClass` its edge turns `--ui-accent-soft` under the pointer.
 *
 * ## The photo
 *
 * Drawn only from an absolute `https:` URL: the URL rides in from an OIDC
 * `picture` claim no earlier hop checks, and an `<img src>` is where a bad
 * scheme would do its harm. The request carries no `Referer`, so the photo's
 * host is not told which page loaded it. `alt=""`: the caller names the person
 * in text, and the whole part is `aria-hidden`.
 *
 * A URL that fails to load — a dead link, a response that is not an image, or a
 * host the page's CSP `img-src` does not list — is kept in one set for the
 * page, so the face that failed falls back at once, and no face that has not
 * drawn that URL asks for it again (one that already drew it keeps it): vendor's placeholder trigger and the real one
 * agree, and the swap between them never flashes an empty circle. A new URL
 * gets its own try. The set lives until the page reloads.
 *
 * ## The ring
 *
 * `ring` draws a 2px band in the page's colour outside the circle, the gap an
 * overlapping stack needs. It is a box-shadow on this part's own root, so the
 * photo keeps the circle's full size; `@shared/ui` `Avatar`'s `ring="surface"`
 * paints a border in the card's colour inside the circle instead.
 *
 * `class` sets the size and the place, nothing else, and is required: the
 * root measures the letter from its own width, so it takes none from its
 * contents and would be no width at all without one. The part imports no
 * Kobalte, so a trigger can draw it before a menu's code has loaded.
 */

type PersonAvatarProps = ({ fallback: "blank" } | { fallback: "initial"; name: string }) & {
  url?: string | null;
  ring?: boolean;
  /** The circle's size, and its place: a container query sets the initial from it, so it must be given. */
  class: string;
};

/**
 * The bare round button an account menu opens from: 36px, `Button`'s own focus
 * ring, and nothing painted of its own — the `initial` avatar inside it, sized
 * `size-full`, draws the hairline circle, the 40% surface and the edge that
 * turns under the pointer.
 */
export const avatarTriggerClass =
  "group/avatar-trigger base:flex base:size-9 base:shrink-0 base:items-center base:justify-center base:rounded-full " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus";

const ROOT = "base:@container base:relative base:flex base:shrink-0 base:rounded-full";

/** An account's circle: the hairline, the 40% surface, the edge under the trigger's pointer. */
const ACCOUNT_FRAME =
  "base:border base:border-ui-hairline base:bg-ui-surface/40 " +
  "base:group-hover/avatar-trigger:border-ui-accent-soft " +
  "base:transition-[border-color] base:duration-(--dur-fast,100ms) base:ease-(--ease-out) " +
  "base:motion-reduce:transition-none";

const RING = "base:ring-2 base:ring-ui-ground";

/** The empty avatar's disc: faint ink laid over the page's colour, so it is opaque. */
const BLANK =
  "base:size-full base:bg-ui-ground base:bg-[linear-gradient(var(--ui-ink-tertiary),var(--ui-ink-tertiary))] " +
  "base:text-ui-ground";

const INITIAL =
  "base:flex base:size-full base:items-center base:justify-center " +
  "base:font-ui-display base:font-semibold base:text-ui-accent-ink base:text-[50cqi] base:leading-none";

const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());

function markFailed(url: string) {
  setFailed((before) => new Set(before).add(url));
}

/** `url` when it is an absolute https URL, else null. */
function httpsOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The first letter of the trimmed name as a reader sees it, or `?`. A letter
 * can be several code points — an accent typed after its letter, a flag — so
 * it is the first grapheme where the browser can segment one, and the first
 * code point where it cannot (Firefox before 125). Upper-cased only when that
 * keeps it one letter: `ß` would become `SS`.
 */
function initialOf(name: string): string {
  const first = firstGrapheme(name.trim());
  if (!first) return "?";
  const upper = first.toUpperCase();
  return Array.from(upper).length === Array.from(first).length ? upper : first;
}

function firstGrapheme(text: string): string | undefined {
  if (typeof Intl.Segmenter !== "function") return Array.from(text)[0];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text,
  )) {
    return segment;
  }
  return undefined;
}

function BlankFigure() {
  return (
    <svg data-blank-avatar viewBox="0 0 32 32" class={BLANK}>
      <circle cx="16" cy="12.25" r="5.75" fill="currentColor" />
      <path d="M4.5 31.5c0-7.2 5.15-11.75 11.5-11.75s11.5 4.55 11.5 11.75z" fill="currentColor" />
    </svg>
  );
}

export default function PersonAvatar(props: PersonAvatarProps) {
  // A photo this face has already drawn stays drawn when the same URL fails
  // for another face later; the store only stops faces that have not.
  const [drawn, setDrawn] = createSignal<string | null>(null);
  const photo = () => {
    const url = httpsOnly(props.url);
    return url && (drawn() === url || !failed().has(url)) ? url : null;
  };
  const frame = () => (props.fallback === "initial" ? ` ${ACCOUNT_FRAME}` : "");
  return (
    <span
      aria-hidden="true"
      class={`${ROOT}${frame()}${props.ring ? ` ${RING}` : ""} ${props.class}`}
    >
      <Avatar class="size-full">
        <Show
          when={photo()}
          keyed
          fallback={
            props.fallback === "initial" ? (
              <span class={INITIAL}>{initialOf(props.name)}</span>
            ) : (
              <BlankFigure />
            )
          }
        >
          {(url) => (
            <AvatarImage
              src={url}
              alt=""
              referrerpolicy="no-referrer"
              onLoad={() => setDrawn(url)}
              onError={() => markFailed(url)}
            />
          )}
        </Show>
      </Avatar>
    </span>
  );
}
