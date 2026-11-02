/**
 * The envelope radiogroup: "None", then one card per `@cire/envelope` catalog
 * entry, laid out as `DesignPicker`'s cards are, with the same roving tabindex
 * and the same instant save (one PUT per choice, outside the save bar).
 *
 * Every catalog envelope is premium (`EnvelopeMeta.tier`). When the wedding may
 * not use one, its card is `aria-disabled` and says "Locked": perceivable and
 * unselectable, as a locked design is. A stored envelope the wedding may no
 * longer use stays checked and says "Switched off": it is still the organiser's
 * choice, and guests are served none. "None" always saves.
 *
 * Its notes say why guests would not see a chosen envelope: the wedding may no
 * longer use it, or the hero it opens onto is switched off or empty on screen.
 */

import { ENVELOPES, type EnvelopeId } from "@cire/envelope";
import type { SectionState } from "@cire/theme";
import { createSignal, For, Show } from "solid-js";

/** One card: an envelope id, or `null` for "None". */
interface Choice {
  readonly id: EnvelopeId | null;
  readonly name: string;
}

const CHOICES: readonly Choice[] = [
  { id: null, name: "None" },
  ...ENVELOPES.map((e) => ({ id: e.id, name: e.name })),
];

export default function EnvelopePicker(props: {
  /** Whether the wedding may use premium envelopes now (`envelopeEntitled`). */
  entitled: boolean;
  /** The server-acknowledged envelope, `null` for none. */
  currentId: string | null;
  saving: boolean;
  /** The hero's state as the organiser has it on screen, saved or not. */
  heroState: SectionState;
  onSelect: (envelopeId: EnvelopeId | null) => void;
}) {
  // Roving tabindex, as in `DesignPicker`: the index of the card that takes Tab,
  // moved by the keyboard independently of the in-flight save; `null` until
  // something moves it, meaning the current choice's card.
  const [activeIndex, setActiveIndex] = createSignal<number | null>(null);
  // A stored id outside the catalog matches no card, so "None" takes the tab stop.
  const tabbableIndex = () =>
    activeIndex() ??
    Math.max(
      0,
      CHOICES.findIndex((choice) => choice.id === props.currentId),
    );

  // Refs so the keyboard can move DOM focus; Solid has no roving primitive.
  const radioRefs: HTMLButtonElement[] = [];

  const locked = (choice: Choice) => choice.id !== null && !props.entitled;

  /** Move focus to a card and, when it is not locked, choose it. */
  function focusChoice(index: number) {
    setActiveIndex(index);
    radioRefs[index]?.focus();
    const choice = CHOICES[index]!;
    if (!locked(choice)) props.onSelect(choice.id);
  }

  /** Arrows step and wrap, Home and End jump; focus lands on a locked card,
   *  but choosing does not follow it there. */
  function onKeyDown(e: KeyboardEvent, from: number) {
    const count = CHOICES.length;
    let to: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        to = from + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        to = from - 1;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusChoice((to + count) % count);
  }

  /** The stored envelope's name while the wedding may not use it, else null. */
  const switchedOffName = () => {
    if (props.entitled) return null;
    return ENVELOPES.find((e) => e.id === props.currentId)?.name ?? null;
  };

  /** Why guests would not see the chosen envelope over the hero, or null. */
  const heroNote = () => {
    if (props.currentId === null || !props.entitled || props.heroState === "shown") return null;
    return props.heroState === "off"
      ? "The envelope opens onto the hero. Turn the hero on to show it."
      : "The envelope opens onto the hero. Add a title, a subtitle or an image to the hero to show it.";
  };

  return (
    <div class="border-border flex flex-col gap-3 border-t pt-4">
      <h3 class="font-body text-gold-ink text-ui-xs tracking-ui-wider uppercase">Envelope</h3>
      <div class="flex flex-wrap gap-3" role="radiogroup" aria-label="Invite envelope">
        <For each={CHOICES}>
          {(choice, index) => {
            const isLocked = () => locked(choice);
            const checked = () => props.currentId === choice.id;
            return (
              <div
                class="border-border flex flex-col items-start gap-2 rounded-sm border px-4 py-3"
                classList={{ "border-gold": checked() }}
              >
                <button
                  type="button"
                  role="radio"
                  ref={(el) => (radioRefs[index()] = el)}
                  aria-checked={checked()}
                  aria-disabled={isLocked() || props.saving ? "true" : undefined}
                  tabIndex={tabbableIndex() === index() ? 0 : -1}
                  onClick={() => {
                    if (isLocked()) return;
                    setActiveIndex(index());
                    props.onSelect(choice.id);
                  }}
                  onKeyDown={(e) => onKeyDown(e, index())}
                  class="flex min-w-32 flex-col items-start gap-1 text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  <EnvelopeSketch sealed={choice.id !== null} />
                  <span class="font-body text-ui-sm">{choice.name}</span>
                  <Show when={isLocked()}>
                    <span class="text-gold-ink text-ui-xs tracking-ui-wider uppercase">Locked</span>
                  </Show>
                  <Show when={checked()}>
                    <span class="text-gold-ink text-ui-xs tracking-ui-wider uppercase">
                      {isLocked() ? "Switched off" : "Current"}
                    </span>
                  </Show>
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={switchedOffName()}>
        {(name) => (
          <p class="font-body text-text-muted text-ui-sm">
            Your {name()} is switched off, so guests open the invite without it. Envelopes come with
            Crimson.
          </p>
        )}
      </Show>
      <Show when={heroNote()}>
        {(note) => <p class="font-body text-text-muted text-ui-sm">{note()}</p>}
      </Show>
      <p class="font-body text-text-muted text-ui-sm">
        Saved instantly. Each guest opens it once, in Chrome on Android or a computer. Other
        browsers, and devices set to reduce motion, show the invite without it.
      </p>
    </div>
  );
}

/**
 * A neutral sketch per card, in the manner of `DesignPicker`'s thumbnails:
 * decorative (`aria-hidden`) and drawn in `currentColor` from the card's
 * `text-text-muted`. "None" is an empty dashed frame; an envelope is an outline
 * with its flap and a plain disc where the seal sits. It is a placeholder, not
 * the seal's art.
 */
function EnvelopeSketch(props: { sealed: boolean }) {
  return (
    <svg viewBox="0 0 120 84" width="120" height="84" aria-hidden="true" class="text-text-muted">
      <Show
        when={props.sealed}
        fallback={
          <rect
            x="25"
            y="17"
            width="70"
            height="50"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-dasharray="4 4"
          />
        }
      >
        <rect
          x="25"
          y="17"
          width="70"
          height="50"
          fill="currentColor"
          fill-opacity="0.15"
          stroke="currentColor"
          stroke-width="2"
        />
        <polyline points="25,17 60,45 95,17" fill="none" stroke="currentColor" stroke-width="2" />
        <circle
          cx="60"
          cy="45"
          r="7"
          fill="currentColor"
          fill-opacity="0.4"
          stroke="currentColor"
          stroke-width="2"
        />
      </Show>
    </svg>
  );
}
