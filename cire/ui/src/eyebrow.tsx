import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

/**
 * The small-caps label that leads a section, a card or a group of fields.
 *
 * One size, one letter-spacing and two inks, in all four cire apps (the
 * owner's choice, englishstreetventures/osn#1833): the widest tracking step,
 * readable gold for `accent` and the neutral secondary ink for `muted`. It
 * sets no weight, so on a guest's invite it follows the body weight the couple
 * picked, as the text around it does.
 *
 * ## Where it does not belong
 *
 * - **A table head.** Small caps too, but its own part (`Th`, `@shared/ui`).
 * - **A scope that re-declares the palette below the root.** The `ui-*` inks
 *   resolve where each app declares them, on `:root`. The guest site puts a
 *   couple's palette on `<html>`, so an eyebrow there takes the couple's gold;
 *   the host's invite preview puts it on a wrapper further down, where an
 *   eyebrow would paint the portal's gold instead. The preview draws its own.
 *
 * `eyebrowClass` gives the same classes to an element `as` does not offer, or
 * to an `.astro` page that would rather not render a component.
 */

export type EyebrowTone = "accent" | "muted";

/** The elements an eyebrow is written as today: a line, a word, a heading, a fieldset's legend, a term. */
export type EyebrowElement = "p" | "span" | "h2" | "h3" | "legend" | "dt";

const EYEBROW_BASE = "base:font-ui-body base:text-ui-xs base:tracking-ui-widest base:uppercase";

const TONE = {
  accent: "base:text-ui-accent-ink",
  muted: "base:text-ui-ink-secondary",
} satisfies Readonly<Record<EyebrowTone, string>>;

export function eyebrowClass(options: { tone?: EyebrowTone } = {}): string {
  return `${EYEBROW_BASE} ${TONE[options.tone ?? "accent"]}`;
}

export interface EyebrowProps {
  tone?: EyebrowTone;
  /** `p` when left out. A heading when the label names its section, so the outline reads it. */
  as?: EyebrowElement;
  id?: string;
  class?: string;
  children: JSX.Element;
}

export default function Eyebrow(props: EyebrowProps): JSX.Element {
  return (
    <Dynamic
      component={props.as ?? "p"}
      id={props.id}
      class={`${eyebrowClass({ tone: props.tone })}${props.class ? ` ${props.class}` : ""}`}
    >
      {props.children}
    </Dynamic>
  );
}
