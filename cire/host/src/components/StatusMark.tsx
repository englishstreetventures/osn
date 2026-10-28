import Check from "lucide-solid/icons/check";
import X from "lucide-solid/icons/x";
import { type Component, type JSX, Show } from "solid-js";

/**
 * A state at a glance: a filled circle with a glyph, then a word in tiny caps
 * (`cire/host/DESIGN.md` §Status marks). Iconography carries the meaning and
 * the word says it, so neither colour nor the glyph is alone. No outline and
 * no border round the word.
 *
 * Four tones, one per kind of answer:
 *
 * | Tone | Circle | Glyph | Word |
 * |---|---|---|---|
 * | `yes` | solid `--status-yes` (gold) | `--on-gold` | `--gold-ink` |
 * | `no` | deep muted red `--status-no` | `--status-no-ink` | `--error` |
 * | `maybe` | gold tint `--status-maybe` | `--status-maybe-ink` | `--text-muted` |
 * | `none` | a ring in `--text-faint`, empty | — | `--text-muted` |
 *
 * Every glyph clears 4.5:1 on its circle and every word 4.5:1 on the page, in
 * both themes (`GuestsMarks.browser.test.tsx`).
 * `stacked` puts the word under the circle, for a narrow fixed column.
 */

export type MarkTone = "yes" | "no" | "maybe" | "none";

type Glyph = Component<{ class?: string; strokeWidth?: number; "aria-hidden"?: "true" }>;

const DOT = {
  yes: "bg-status-yes text-on-gold",
  no: "bg-status-no text-status-no-ink",
  maybe: "bg-status-maybe text-status-maybe-ink",
  none: "border-text-faint border-2",
} satisfies Readonly<Record<MarkTone, string>>;

const WORD = {
  yes: "text-gold-ink",
  no: "text-error",
  maybe: "text-text-muted",
  none: "text-text-muted",
} satisfies Readonly<Record<MarkTone, string>>;

/** A "?" for Maybe: lucide's question mark without its circle. */
export const QuestionGlyph: Glyph = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={props.strokeWidth ?? 2}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden={props["aria-hidden"]}
    class={props.class}
  >
    <path d="M8.5 9a3.5 3.5 0 1 1 5.3 3c-1.1.6-1.8 1.4-1.8 2.6" />
    <path d="M12 18.5h.01" />
  </svg>
);

/** The glyph each reply wears. */
export const REPLY_GLYPH = {
  yes: Check,
  no: X,
  maybe: QuestionGlyph,
  none: undefined,
} satisfies Readonly<Record<MarkTone, Glyph | undefined>>;

/** The circle alone, for a place that says the word elsewhere — a chip. */
export function StatusDot(props: { tone: MarkTone; glyph?: Glyph }) {
  const glyph = () => props.glyph ?? REPLY_GLYPH[props.tone];
  return (
    <span
      data-status-dot
      aria-hidden="true"
      class={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-full ${DOT[props.tone]}`}
    >
      <Show when={glyph()}>
        {(Icon) => {
          const G = Icon();
          return <G aria-hidden="true" strokeWidth={3} class="size-2" />;
        }}
      </Show>
    </span>
  );
}

export function StatusMark(props: {
  tone: MarkTone;
  /** The word, as the state is named — "Attending", "Sent". */
  label: string;
  /** The glyph in the circle; the reply glyph for the tone when absent. */
  glyph?: Glyph;
  /** Word under the circle, for a narrow fixed column. */
  stacked?: boolean;
  /** Read by tests and styles: which reply this is. */
  status?: string;
  /** Extra words for a screen reader, after the label. */
  more?: JSX.Element;
}) {
  const glyph = () => props.glyph ?? REPLY_GLYPH[props.tone];
  return (
    <span
      data-status={props.status}
      class={`inline-flex shrink-0 items-center whitespace-nowrap ${
        props.stacked ? "flex-col gap-1" : "gap-1.5"
      }`}
    >
      <span
        data-status-dot
        aria-hidden="true"
        class={`inline-flex shrink-0 items-center justify-center rounded-full ${
          props.stacked ? "size-5" : "size-4"
        } ${DOT[props.tone]}`}
      >
        <Show when={glyph()}>
          {(Icon) => {
            const G = Icon();
            return (
              <G aria-hidden="true" strokeWidth={3} class={props.stacked ? "size-3" : "size-2.5"} />
            );
          }}
        </Show>
      </span>
      <span
        data-status-label
        class={`font-body text-ui-xs tracking-ui-wider leading-none font-medium uppercase ${WORD[props.tone]}`}
      >
        {props.label}
        {props.more}
      </span>
    </span>
  );
}
