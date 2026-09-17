import { Show, splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * A block that says something went wrong, or right, or is about to.
 *
 * Written longhand at every call site before this, which is how one portal
 * ended up with three error blocks at three different paddings and two
 * different border opacities, and a fourth that was not tinted at all and so
 * did not read as an error. Four tones, all built the same way: a faint tinted
 * ground, a border of the same hue, and the text in it.
 *
 * ## The mark, not just the hue
 *
 * Three of the tones lead with a glyph, and the three glyphs are different
 * *shapes* rather than three colours of the same shape. Tone carried by hue
 * alone puts "saved" and "failed to save" in the same place in the same
 * rectangle, and `danger` and `warn` are the closest pair in most palettes —
 * exactly the pair red-green colour blindness collapses. The glyph is
 * `aria-hidden` and a word is read in its place, because "✕" is not a thing to
 * hear.
 *
 * `info` gets no mark. It is the standing-note tone: nothing has happened.
 *
 * ## `alert`
 *
 * Off by default. The role is a live region: assistive tech interrupts to read
 * it, which is right for a save that just failed and wrong for a standing note
 * that was on screen before the reader arrived. Set it where the notice
 * *appears* in response to something the reader did.
 */

export type NoticeTone = "danger" | "warn" | "success" | "info";

const BASE =
  "base:font-ui-body base:flex base:items-start base:gap-2.5 base:rounded-ui-sm " +
  "base:border base:p-4 base:text-ui-base base:leading-ui-relaxed";

const TONE = {
  danger: "base:border-ui-danger/20 base:bg-ui-danger/5 base:text-ui-danger",
  warn: "base:border-ui-warn/20 base:bg-ui-warn/5 base:text-ui-warn",
  success: "base:border-ui-success/20 base:bg-ui-success/5 base:text-ui-success",
  info: "base:border-ui-hairline base:bg-ui-surface/30 base:text-ui-ink-secondary",
} satisfies Readonly<Record<NoticeTone, string>>;

interface Mark {
  /** Seen, never read. */
  glyph: string;
  /** Read, never seen. */
  word: string;
}

const MARK = {
  danger: { glyph: "✕", word: "Error" },
  warn: { glyph: "!", word: "Warning" },
  success: { glyph: "✓", word: "Success" },
  info: undefined,
} satisfies Readonly<Record<NoticeTone, Mark | undefined>>;

export type NoticeProps = SafeProps<"div"> & {
  tone?: NoticeTone;
  /** Announce it the moment it appears. See the note above. */
  alert?: boolean;
};

export function Notice(props: NoticeProps) {
  const [own, rest] = splitProps(props, ["tone", "alert", "class", "children"]);
  const mark = () => MARK[own.tone ?? "info"];
  return (
    <div
      role={own.alert ? "alert" : undefined}
      {...rest}
      class={`${BASE} ${TONE[own.tone ?? "info"]}${own.class ? ` ${own.class}` : ""}`}
    >
      <Show when={mark()}>
        {(m) => (
          <>
            <span
              aria-hidden="true"
              class="base:w-3 base:shrink-0 base:select-none base:text-center base:leading-ui-relaxed"
            >
              {m().glyph}
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
