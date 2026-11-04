import { composeControl } from "@shared/ui/ui/control";
import { Field } from "@shared/ui/ui/field";
import { createSignal, type JSX } from "solid-js";

import Button from "./button";

/**
 * The reply box under an enquiry thread, and its send button.
 *
 * No send button until the box holds something other than spaces; then a
 * round one springs in beside it and the box gives way from its right edge.
 * The box and the button are one height, and the box grows only when the
 * words wrap (the owner's composer on englishstreetventures/osn#1850).
 *
 * ## Two looks, one switch
 *
 * `field`, which both portals draw (the owner's choice): 34px, a portal form
 * field's height (host DESIGN.md §4, "One form-field height"), at the 14px
 * field corner. `pill`: 36px, the box a pill at one line (an 18px corner,
 * which it keeps as it grows), as the owner's round-three demo drew it.
 * `COMPOSER_SIZE` is the look every portal's thread draws, so moving both
 * portals to the pill is that one line; `size` draws either one where it is
 * passed, and the browser tests hold both.
 *
 * ## Why a native textarea and not `Textarea`
 *
 * `Textarea` sets a 60px floor, for a box that is a form's long answer. This
 * box starts at one line, so it takes the shared control's look at the `form`
 * size from `composeControl` and sets its own line: 20px of leading and 6px
 * above and below it, inside a 1px edge, is 34px whatever the font measures;
 * 7px above and below is the pill's 36px. The pill's corner re-points
 * `--ui-radius-field` on the box itself, which the control's `rounded-ui-field`
 * reads at the element (`@theme inline`), so the box keeps one corner class.
 *
 * ## The growth
 *
 * On each input the box is sized to its content, up to `7.5rem` (five lines),
 * after which it scrolls. A send that clears it puts it back to one line; a
 * value written from code fires no `input`, so the reset is explicit. It never
 * offers a resize grip: the portals' auto-sized frames read a height change at
 * a fixed width as content, and a grip dragged is a stream of them.
 *
 * ## The button's arrival
 *
 * The motion is on a wrapper, not on `Button`, whose own transition list is its
 * own: the wrapper's width and left margin open from 0 to the button's size
 * and 8px and its `scale` grows from 0.4, on the portals' slow step and spring, while its
 * opacity fades on the base step. The list names those four properties and
 * nothing else, so the button's focus ring never animates. While hidden the button is
 * disabled and out of the tab order and the accessibility tree.
 *
 * The wrapper clips the button only while it is hidden, so nothing of it
 * reaches past the box. Shown, the wrapper is exactly the button's size, and
 * an `overflow` clip there would cut off the whole focus ring, 2px wide and
 * 2px out; instead an inset `clip-path` 4px outside the wrapper keeps the
 * clipped arrival and leaves the ring whole.
 */

const MAX_HEIGHT = "7.5rem";

/**
 * Each look's padding and corner on the box, and its button's and the shown
 * wrapper's size: one 20px line plus the padding and the 1px edge is the
 * button's height.
 */
export const COMPOSER_LOOKS = {
  field: { box: "base:py-1.5", send: "h-8.5 w-8.5", shown: "base:w-8.5" },
  pill: { box: "base:py-1.75 base:[--ui-radius-field:18px]", send: "h-9 w-9", shown: "base:w-9" },
} as const;

export type ComposerSize = keyof typeof COMPOSER_LOOKS;

/** The look both portals' threads draw. `"pill"` moves both to the 36px pill. */
export const COMPOSER_SIZE: ComposerSize = "field";

/** The box: the shared control's look at `form`, one 20px line, the look's padding. */
const boxClass = (size: ComposerSize) =>
  `${composeControl("form", undefined, "ground", `base:px-3 ${COMPOSER_LOOKS[size].box}`)} base:block base:min-w-0 base:flex-1 base:leading-5 base:resize-none base:overflow-y-auto`;

const SEND_WRAP_BASE =
  "base:flex base:shrink-0 base:origin-center " +
  "base:transition-[width,margin-left,scale,opacity] " +
  "base:duration-[var(--dur-slow,var(--ui-dur-slow,320ms)),var(--dur-slow,var(--ui-dur-slow,320ms)),var(--dur-slow,var(--ui-dur-slow,320ms)),var(--dur-base,var(--ui-dur-base,200ms))] " +
  "base:ease-[var(--ease-spring,var(--ease-out,var(--ui-ease-out))),var(--ease-spring,var(--ease-out,var(--ui-ease-out))),var(--ease-spring,var(--ease-out,var(--ui-ease-out))),var(--ease-out,var(--ui-ease-out))]";

/** Shown: clipped where the button's focus ring ends, its 2px offset and 2px width outside the box. */
const SEND_WRAP_SHOWN =
  "base:ml-2 base:scale-100 base:opacity-100 base:overflow-visible base:[clip-path:inset(calc(-2px_-_2px))]";
/** Hidden: clipped to its box, which is no width at all. */
const SEND_WRAP_HIDDEN = "base:w-0 base:ml-0 base:scale-40 base:opacity-0 base:overflow-hidden";

export interface MessageComposerProps {
  /** Resolves when the message is sent: the box clears. Rejects: the words stay. */
  onSend: (text: string) => Promise<void>;
  placeholder?: string;
  /** Shown under the box, which is marked invalid while it shows. */
  error?: string | null;
  /** The look; `COMPOSER_SIZE` unless given. */
  size?: ComposerSize;
}

/** An arrow pointing up: send. Drawn on a 20px grid, stroked in the button's ink. */
function SendGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10 15V5M5.5 9.5 10 5l4.5 4.5" />
    </svg>
  );
}

export default function MessageComposer(props: MessageComposerProps): JSX.Element {
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let box: HTMLTextAreaElement | undefined;

  const ready = () => draft().trim() !== "";
  const look = () => COMPOSER_LOOKS[props.size ?? COMPOSER_SIZE];

  /** Fit the box to its words, up to the cap; an empty style puts it back to one line. */
  function fit(el: HTMLTextAreaElement) {
    el.style.height = "";
    if (el.value === "") return;
    const edge = el.offsetHeight - el.clientHeight;
    el.style.height = `min(${el.scrollHeight + edge}px, ${MAX_HEIGHT})`;
  }

  async function send() {
    const text = draft().trim();
    if (text === "" || sending()) return;
    setSending(true);
    try {
      await props.onSend(text);
      setDraft("");
      if (box) {
        box.value = "";
        fit(box);
      }
    } catch {
      // The caller says what went wrong; the words stay for another try.
    } finally {
      setSending(false);
      // The button was disabled under the pointer, which drops focus to the
      // page; the box is where the next words go either way.
      box?.focus();
    }
  }

  return (
    <Field label="Reply" labelHidden errors={props.error ? [props.error] : undefined}>
      {(field) => (
        <div class="base:flex base:items-end">
          <textarea
            {...field}
            ref={box}
            name="reply"
            // A message, not a form value a browser should offer to fill.
            autocomplete="off"
            rows={1}
            class={boxClass(props.size ?? COMPOSER_SIZE)}
            placeholder={props.placeholder ?? "Write a reply…"}
            value={draft()}
            onInput={(event) => {
              setDraft(event.currentTarget.value);
              fit(event.currentTarget);
            }}
          />
          <span
            class={`${SEND_WRAP_BASE} ${ready() ? `${SEND_WRAP_SHOWN} ${look().shown}` : SEND_WRAP_HIDDEN}`}
          >
            <Button
              variant="primary"
              size="icon"
              aria-label="Send"
              class={look().send}
              disabled={!ready() || sending()}
              aria-busy={sending() ? "true" : undefined}
              aria-hidden={ready() ? undefined : "true"}
              tabindex={ready() ? undefined : "-1"}
              onClick={() => void send()}
            >
              <SendGlyph />
            </Button>
          </span>
        </div>
      )}
    </Field>
  );
}
