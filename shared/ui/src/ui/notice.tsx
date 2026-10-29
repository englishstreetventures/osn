import { type JSX, Show, splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * A block that says something went wrong, or right, or is about to.
 *
 * Written longhand at every call site before this, which is how one portal
 * ended up with three error blocks at three different paddings and two
 * different border opacities, and a fourth that was not tinted at all and so
 * did not read as an error. Five tones, all built the same way: a faint tinted
 * ground, a border of the same hue, and the text in it.
 *
 * ## Three sizes
 *
 * `md`, the default, is the box every app drew before the others existed.
 * `sm` is the same box, compact, for a note beside a control or inside a
 * sidebar. `inline` is no box at all — no border, no fill, no padding — for
 * the error line under a field: the mark, the read word and the text, in the
 * tone's ink. All three are a `<div>`, so none may sit inside a `<p>` or a
 * `<label>`; a call site there moves the line out of the paragraph.
 *
 * ## The mark, not just the hue
 *
 * Three of the tones lead with a circled icon, and the three icons are
 * different *shapes* — a cross, an exclamation mark, a tick — rather than
 * three colours of the same shape. Tone carried by hue alone puts "saved" and
 * "failed to save" in the same place in the same rectangle, and `danger` and
 * `warn` are the closest pair in most palettes — exactly the pair red-green
 * colour blindness collapses. The icon is drawn here, inline, in
 * `currentColor`, so it takes the tone's ink and needs no icon package. Its
 * `width` and `height` are SVG attributes in `em`, so it follows the text step
 * — the token scale has no step for "a little over the text's size" — and its
 * slot is one line tall (`h-lh`), so a wrapped message keeps it centred on its
 * first line. It is `aria-hidden` and a word is read in its place, because a
 * drawn cross is not a thing to hear.
 *
 * `info` and `accent` get no mark. They are the standing-note tones: nothing
 * has happened. `accent` is the same note in the app's accent, for a note an
 * app wants to stand out; it paints `--ui-accent-ink`, the accent as readable
 * ink, never the accent itself, which carries no contrast promise.
 *
 * `mark` lets an app draw its own mark in the same slot — an icon and the word
 * read in its place — for a part of its own built on a tone that has none.
 * It adds a mark; it never takes one away.
 *
 * ## `alert`
 *
 * Off by default. The role is a live region: assistive tech interrupts to read
 * it, which is right for a save that just failed and wrong for a standing note
 * that was on screen before the reader arrived. Set it where the notice
 * *appears* in response to something the reader did.
 */

export type NoticeTone = "danger" | "warn" | "success" | "info" | "accent";

export type NoticeSize = "inline" | "sm" | "md";

const SIZE = {
  inline:
    "base:font-ui-body base:flex base:items-start base:gap-1.5 base:text-ui-sm base:leading-ui-snug",
  sm:
    "base:font-ui-body base:flex base:items-start base:gap-2 base:rounded-ui-sm " +
    "base:border base:px-3 base:py-2 base:text-ui-sm base:leading-ui-normal",
  md:
    "base:font-ui-body base:flex base:items-start base:gap-2.5 base:rounded-ui-sm " +
    "base:border base:p-4 base:text-ui-base base:leading-ui-relaxed",
} satisfies Readonly<Record<NoticeSize, string>>;

/** The box a tone draws at `sm` and `md`; `inline` draws none. */
const BOX = {
  danger: "base:border-ui-danger/20 base:bg-ui-danger/5",
  warn: "base:border-ui-warn/20 base:bg-ui-warn/5",
  success: "base:border-ui-success/20 base:bg-ui-success/5",
  info: "base:border-ui-hairline base:bg-ui-surface/30",
  accent: "base:border-ui-accent/40 base:bg-ui-accent/5",
} satisfies Readonly<Record<NoticeTone, string>>;

const INK = {
  danger: "base:text-ui-danger",
  warn: "base:text-ui-warn",
  success: "base:text-ui-success",
  info: "base:text-ui-ink-secondary",
  accent: "base:text-ui-accent-ink",
} satisfies Readonly<Record<NoticeTone, string>>;

export interface NoticeMark {
  /** Seen, never read. Drawn in `currentColor`, sized in `em`. */
  icon: JSX.Element;
  /** Read, never seen. */
  word: string;
}

/** A circle, and the shape inside it that says which tone this is. */
function Circled(props: { children: JSX.Element }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="1.15em"
      height="1.15em"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      {props.children}
    </svg>
  );
}

/** Built on demand, so a notice that is never marked creates no SVG. */
const MARK = {
  danger: () => ({
    icon: (
      <Circled>
        <path d="m15 9-6 6M9 9l6 6" />
      </Circled>
    ),
    word: "Error",
  }),
  warn: () => ({
    icon: (
      <Circled>
        <path d="M12 7.5v5M12 16.5h.01" />
      </Circled>
    ),
    word: "Warning",
  }),
  success: () => ({
    icon: (
      <Circled>
        <path d="m8 12.5 2.75 2.75L16 9.5" />
      </Circled>
    ),
    word: "Success",
  }),
  info: undefined,
  accent: undefined,
} satisfies Readonly<Record<NoticeTone, (() => NoticeMark) | undefined>>;

export type NoticeProps = SafeProps<"div"> & {
  tone?: NoticeTone;
  size?: NoticeSize;
  /** Announce it the moment it appears. See the note above. */
  alert?: boolean;
  /** An app's own mark, for a tone that has none. See the note above. */
  mark?: NoticeMark;
};

export function Notice(props: NoticeProps) {
  const [own, rest] = splitProps(props, ["tone", "size", "alert", "mark", "class", "children"]);
  const tone = () => own.tone ?? "info";
  const size = () => own.size ?? "md";
  const mark = () => own.mark ?? MARK[tone()]?.();
  const look = () =>
    size() === "inline"
      ? `${SIZE.inline} ${INK[tone()]}`
      : `${SIZE[size()]} ${BOX[tone()]} ${INK[tone()]}`;
  return (
    <div
      role={own.alert ? "alert" : undefined}
      {...rest}
      class={`${look()}${own.class ? ` ${own.class}` : ""}`}
    >
      <Show when={mark()}>
        {(m) => (
          <>
            {/* One line tall, so the icon sits beside the first line however
                many the words wrap to. */}
            <span aria-hidden="true" class="base:flex base:h-lh base:shrink-0 base:items-center">
              {m().icon}
            </span>
            <span class="base:sr-only">{m().word}: </span>
          </>
        )}
      </Show>
      {/* Its own box, so a run of text and an inline element inside it stay one
          paragraph rather than becoming two flex items with a gap between them. */}
      <div class="base:min-w-0">{own.children}</div>
    </div>
  );
}
