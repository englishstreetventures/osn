import { Show, splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * A block that says something went wrong, or right, or is about to.
 *
 * The error tone alone was written out longhand thirteen times, which is how it
 * ended up with three different paddings. Four tones, all built the same way: a
 * faint tinted ground, a border of the same hue, and the text in it.
 *
 * ## The mark, not just the hue
 *
 * Three of the tones lead with a glyph, and the three glyphs are different
 * shapes rather than three colours of the same shape. Tone carried by hue alone
 * puts "saved" and "failed to save" in the same place in the same rectangle, and
 * `error` and `warn` are the closest pair in the portal's palette — exactly the
 * pair red-green colour blindness collapses. The glyph is `aria-hidden` and a
 * word is read in its place, because "✕" is not a thing to hear.
 *
 * `info` gets no mark. It is the standing-note tone: nothing has happened.
 *
 * ## `alert`
 *
 * Off by default. The role is a live region: assistive tech interrupts to read
 * it, which is right for a save that just failed and wrong for a standing note
 * that was on screen before the host arrived. Set it where the notice *appears*
 * in response to something the host did.
 */

export type NoticeTone = "error" | "warn" | "success" | "info";

const BASE =
  "font-body flex items-start gap-2.5 rounded-sm border p-4 text-[0.88rem] leading-relaxed";

const TONE: Readonly<Record<NoticeTone, string>> = {
  error: "border-error/20 bg-error/5 text-error",
  warn: "border-warn/20 bg-warn/5 text-warn",
  success: "border-success/20 bg-success/5 text-success",
  info: "border-border bg-surface/30 text-text-muted",
};

interface Mark {
  /** Seen, never read. */
  glyph: string;
  /** Read, never seen. */
  word: string;
}

const MARK: Readonly<Record<NoticeTone, Mark | undefined>> = {
  error: { glyph: "✕", word: "Error" },
  warn: { glyph: "!", word: "Warning" },
  success: { glyph: "✓", word: "Success" },
  info: undefined,
};

export type NoticeProps = SafeProps<"div"> & {
  tone?: NoticeTone;
  /** Announce it the moment it appears. See the note above. */
  alert?: boolean;
};

export default function Notice(props: NoticeProps) {
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
            <span aria-hidden="true" class="w-3 shrink-0 text-center leading-relaxed select-none">
              {m().glyph}
            </span>
            <span class="sr-only">{m().word}: </span>
          </>
        )}
      </Show>
      {/* Its own box, so a run of text and an inline element inside it stay one
          paragraph rather than becoming two flex items with a gap between them. */}
      <div class="min-w-0">{own.children}</div>
    </div>
  );
}
