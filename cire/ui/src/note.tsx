import { Notice, type NoticeProps } from "@shared/ui/ui/notice";

/**
 * Cire's standing note: `@shared/ui` `Notice`'s accent tone — its border at 40%
 * of the gold, a 5% tint, readable gold ink — led by a ✦, the house ornament,
 * with "Note" read in its place.
 *
 * The shared accent tone carries no mark, so the other products draw it bare;
 * the ✦ is cire's own (englishstreetventures/osn#1868). It is drawn as
 * `Notice`'s circled icons are: inline SVG in `currentColor`, so it takes the
 * tone's ink, sized in `em` from the text step, in `Notice`'s mark slot — one
 * line tall, `aria-hidden` and `inert`. Each note builds its own star; one
 * shared node would be moved from note to note and leave the rest bare.
 *
 * The box is `Notice`'s, at `sm` unless a size is asked for (`inline` and `md`
 * as `Notice` draws them), and so is `alert`. Nothing a caller spreads changes
 * the tone or the mark: both are set after the caller's props.
 *
 * ## Where it goes
 *
 * Only where the owner asks for one. A standing note anywhere else is
 * `Notice`'s `accent` tone, unmarked.
 *
 * ## Where it does not belong
 *
 * - **The marketing site.** It maps `--ui-accent-ink` to its metal gold, which
 *   carries no contrast promise, so a note there would read in it.
 * - **A scope that re-declares the palette below the root.** The `ui-*` inks
 *   resolve where each app declares them, on `:root`; the host's invite
 *   preview puts a couple's palette on a wrapper further down, where a note
 *   would paint the portal's gold.
 * - **The receded ground** (`--bg-deep`, under a scrim or a stuck bar): the
 *   gold words read 4.35:1 there on the light theme. `cire/host`'s
 *   `tests/styles/notice-contrast.browser.test.tsx` holds every other ground
 *   at 4.5:1.
 *
 * It takes `Notice`'s props — a size, `alert`, an `id`, `aria-describedby`,
 * `data-*` and a layout class — and nothing else reaches the element. It takes
 * no `fill`: a note is the gold box with its tint.
 */

export type NoteProps = Omit<NoticeProps, "tone" | "mark" | "fill">;

/** A four-pointed star with curved sides, the ✦ the portal's ornament draws. */
function Star() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="1.15em"
      height="1.15em"
      fill="currentColor"
    >
      <path d="M12 2.5c.6 4.9 4.6 8.9 9.5 9.5-4.9.6-8.9 4.6-9.5 9.5-.6-4.9-4.6-8.9-9.5-9.5 4.9-.6 8.9-4.6 9.5-9.5Z" />
    </svg>
  );
}

export default function Note(props: NoteProps) {
  return <Notice size="sm" {...props} tone="accent" mark={{ icon: <Star />, word: "Note" }} />;
}
