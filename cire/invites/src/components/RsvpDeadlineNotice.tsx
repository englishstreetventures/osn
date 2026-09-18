import { Show } from "solid-js";

import { deadlineNotice, deadlineSummary, type RsvpDeadlineState } from "./rsvp-deadline";
import type { RsvpDeadline } from "./types";

interface RsvpDeadlineNoticeProps {
  deadline: RsvpDeadline | null | undefined;
  state: RsvpDeadlineState | null;
  /**
   * Which of the two copies this is: `notice` labels the event list, `panel`
   * sits in the claim panel where a guest lands. The words come from this and
   * the state together, so the sentence and the treatment can never come apart.
   */
  variant: "notice" | "panel";
  /**
   * Announce changes to assistive technology. **Exactly one copy per page sets
   * this** — a second live region would read the same fact twice every time the
   * deadline moved. The other copy is an ordinary paragraph: reachable in
   * browse mode like any other text, never announced.
   */
  announce?: boolean;
  id?: string;
  /** Per-pack placement and spacing. */
  class?: string;
}

/**
 * The treatment for each state, as whole literal class strings so Tailwind's
 * scanner emits every one of them.
 *
 * Three states, three shapes: a plain line while the date is comfortably ahead,
 * a bordered block once the final week starts, a receding one once the door has
 * shut. The border sits over the section's own surface with nothing washed
 * behind the text, so the ink lands on exactly the backdrop
 * `--color-gold-ink` and `--color-text-muted` are already walked to 4.5:1
 * against.
 *
 * `text-gold-ink`, never `text-gold`: this is a sentence at normal size, which
 * WCAG 1.4.3 puts at 4.5:1, while the metal token is held only to the 3:1 UI
 * floor so a genuinely gold gold survives.
 */
function treatment(state: RsvpDeadlineState): string {
  switch (state) {
    case "closing-soon":
      return "border-gold/40 text-gold-ink rounded-sm border px-4 py-3";
    case "closed":
      return "border-border text-text-muted rounded-sm border px-4 py-3";
    default:
      return "text-gold-ink";
  }
}

/**
 * The wedding's RSVP-by date, in the claim panel a guest lands on and again on
 * top of the events they have to answer.
 *
 * Renders nothing for a wedding with no deadline. Urgency is carried by the
 * words as well as the box — hue alone would say nothing to a guest who cannot
 * separate these two golds (WCAG 1.4.1).
 */
export function RsvpDeadlineNotice(props: RsvpDeadlineNoticeProps) {
  const line = () => {
    const state = props.state;
    if (!state) return null;
    const text =
      props.variant === "panel"
        ? deadlineSummary(props.deadline, state)
        : deadlineNotice(props.deadline, state);
    return text ? { text, state } : null;
  };

  return (
    <Show when={line()}>
      {(shown) => (
        <p
          id={props.id}
          class={`font-body text-ui-base ${treatment(shown().state)} ${props.class ?? ""}`.trim()}
          // A live region because `createRsvpDeadlineState`'s timer rewrites
          // this sentence under a guest who is only reading. Not `<output>`,
          // which carries the same implicit role but is form-associated.
          role={props.announce ? "status" : undefined}
        >
          {shown().text}
        </p>
      )}
    </Show>
  );
}
