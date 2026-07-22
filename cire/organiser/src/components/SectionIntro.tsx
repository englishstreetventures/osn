import type { JSX } from "solid-js";
import { Show } from "solid-js";

/**
 * The shared header for a dashboard section or tab panel — an uppercase gold
 * eyebrow, a serif heading, and an optional one-line description. Every
 * tab leads with one of these so the panels read as one consistent family
 * (Invite / Import already used this shape inline; this is that pattern extracted
 * so Guests / Events / Codes / Hosts match it exactly). `actions` slots a control
 * (e.g. an export button) to the right of the heading on wider screens.
 */
export default function SectionIntro(props: {
  eyebrow: string;
  title: string;
  description?: string;
  /** Right-aligned controls (a button, a count) that belong with this header. */
  actions?: JSX.Element;
}) {
  return (
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">{props.eyebrow}</p>
        <h2 class="font-display text-text text-[1.4rem] font-light">{props.title}</h2>
        <Show when={props.description}>
          <p class="font-body text-text-muted max-w-prose text-[0.82rem] leading-relaxed">
            {props.description}
          </p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="flex shrink-0 items-center gap-3">{props.actions}</div>
      </Show>
    </div>
  );
}
