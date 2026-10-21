import { createEffect, on } from "solid-js";

/** The event sheet's two panels, in the order the switch shows them. */
export type SwitchPanel = "details" | "rsvp";

/** Where the pill rests under each segment, as a share of one segment's width. */
const REST = { details: 0, rsvp: 1 } as const satisfies Record<SwitchPanel, number>;

/** What `EventSheet` drives while a swipe is under way. */
export interface PanelSwitchControl {
  /**
   * Stand the pill at `progress`: 0 under Details, 1 under the form's segment,
   * and anything between while a finger drags the panels. `dragging` holds it
   * to the finger with no easing; otherwise it eases there on the panels'
   * settle timing.
   */
  setProgress(progress: number, dragging: boolean): void;
}

export interface PanelSwitchProps {
  /** The panel on screen. */
  selected: SwitchPanel;
  /** The form's segment: "Respond", or "Your RSVP" once RSVPs have closed. */
  rsvpLabel: string;
  /** The details' segment takes no press: the form is saving, or closing on a saved reply. */
  detailsDisabled?: boolean;
  /** A press of a segment, the one on screen included; the sheet decides what it does. */
  onPress: (panel: SwitchPanel, e: MouseEvent) => void;
  /** Receives the control a swipe drives. */
  ref?: (control: PanelSwitchControl) => void;
}

/**
 * A segment's words, set alike on its button and in the overlay, so the two
 * lie exactly over each other.
 */
const LABEL =
  "font-body text-ui-xs tracking-ui-wider flex min-h-11 items-center justify-center px-3 leading-none whitespace-nowrap uppercase";

/**
 * The event sheet's way between its panels: two segments, Details and
 * Respond, in the sheet's chrome beside the close button. Both are always
 * there, so the row never stands empty and the guest can see where else there
 * is to go; the one on screen is filled gold.
 *
 * ## The pill follows the finger
 *
 * The gold pill and the on-gold labels drawn over it move on one custom
 * property, `--seg-progress`: 0 under Details, 1 under the form's segment. A
 * swipe writes the share of the panels' width the finger has covered, so the
 * pill slides with the panels rather than flashing over when they land, and the
 * labels change ink exactly where the pill's edge crosses them. At rest, and on
 * a press, it eases on the panels' own 280ms (`transition-switch-settle`).
 *
 * There is one writer of the property, {@link PanelSwitchControl.setProgress}.
 * It is written once as the switch is built, from `selected`, so a sheet that
 * opens on the form does not slide its pill across as it opens; after that the
 * switch writes it when `selected` changes, and `EventSheet` writes it through
 * the control during a swipe and at its settle.
 *
 * ## Three layers
 *
 * Under the buttons, the pill: gold, with no words. Then the buttons, which
 * carry the words in the prose gold and are the only thing here that takes a
 * pointer or focus. Over them, the overlay: the same words in the on-gold ink,
 * clipped to the pill's shape and place, so wherever the pill is, its words are
 * on-gold and every other word is gold. Both decorations are `aria-hidden` and
 * `pointer-events-none`, so a tap lands on a button and assistive technology
 * hears each word once. The overlay sits outside the buttons, and its clip stays
 * inside the chosen button's box, so that button's focus ring, drawn outside
 * its box, is never covered.
 *
 * The geometry is inline `transform` and `clip-path` rather than Tailwind's
 * `translate-x-*`, which writes the separate `translate` property: one
 * transition list then covers both layers.
 *
 * ## Semantics
 *
 * A `group` of two toggle buttons with `aria-pressed`, since each segment is a
 * button that shows a panel and says whether its panel is the one on screen.
 * The two buttons are fixed slots rather than a list, so a relabel (Respond to
 * "Your RSVP" as the deadline passes) changes the words in the element that
 * holds focus rather than replacing it.
 */
export function PanelSwitch(props: PanelSwitchProps) {
  let root: HTMLDivElement | undefined;

  const control: PanelSwitchControl = {
    setProgress(progress, dragging) {
      if (!root) return;
      root.toggleAttribute("data-dragging", dragging);
      root.style.setProperty("--seg-progress", String(progress));
    },
  };
  props.ref?.(control);

  createEffect(
    on(
      () => props.selected,
      (selected) => control.setProgress(REST[selected], false),
      { defer: true },
    ),
  );

  return (
    <div
      ref={(el) => {
        root = el;
        // Before the first paint, so the pill starts where it belongs.
        el.style.setProperty("--seg-progress", String(REST[props.selected]));
      }}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<fieldset>`: these are no form's controls, and a fieldset would bring its UA border, padding and min-content sizing into the sheet's chrome.
      role="group"
      aria-label="Event sheet"
      class="border-gold/40 bg-surface relative grid grid-cols-2 rounded-full border"
    >
      <span
        aria-hidden="true"
        class="bg-gold transition-switch-settle pointer-events-none absolute inset-y-0 left-0 w-1/2 rounded-full"
        style={{ transform: "translateX(calc(var(--seg-progress) * 100%))" }}
      />
      <button
        type="button"
        aria-pressed={props.selected === "details"}
        disabled={props.detailsDisabled}
        class={`${LABEL} text-gold-ink relative rounded-full disabled:opacity-40`}
        onClick={(e) => props.onPress("details", e)}
      >
        Details
      </button>
      <button
        type="button"
        aria-pressed={props.selected === "rsvp"}
        class={`${LABEL} text-gold-ink relative rounded-full`}
        onClick={(e) => props.onPress("rsvp", e)}
      >
        {props.rsvpLabel}
      </button>
      <span
        aria-hidden="true"
        class="text-on-gold transition-switch-settle pointer-events-none absolute inset-0 grid grid-cols-2"
        style={{
          "clip-path":
            "inset(0 calc((1 - var(--seg-progress)) * 50%) 0 calc(var(--seg-progress) * 50%) round 9999px)",
        }}
      >
        <span class={LABEL}>Details</span>
        <span class={LABEL}>{props.rsvpLabel}</span>
      </span>
    </div>
  );
}
