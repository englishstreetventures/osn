import type { JSX } from "solid-js";
import { Show } from "solid-js";

/**
 * The shared header for a dashboard section or tab panel — a serif heading
 * and an optional one-line description. Every tab leads with one of these so
 * the panels read as one family. No eyebrow over the heading: the module's
 * header, its tab and the heading already name the panel (DESIGN.md §3, "A
 * line earns its place"). `actions` slots a control (e.g. an export button)
 * to the right of the heading on wider screens.
 */
export default function SectionIntro(props: {
  title: string;
  description?: string;
  /** Right-aligned controls (a button, a count) that belong with this header. */
  actions?: JSX.Element;
  /**
   * While the view's first read is out: the actions keep their room but are
   * not drawn, and no pointer, key or screen reader reaches them
   * (`visibility: hidden`). A phone wraps them onto a row of their own, so
   * arriving with the list they would push it down (DESIGN.md §4, Skeletons).
   */
  holdActions?: boolean;
}) {
  return (
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div class="flex flex-col gap-1">
        <h2 class="font-display text-text text-ui-lg font-light">{props.title}</h2>
        <Show when={props.description}>
          <p class="font-body text-text-muted text-ui-sm leading-ui-normal max-w-prose">
            {props.description}
          </p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div
          data-intro-actions
          class="flex shrink-0 items-center gap-3"
          classList={{ invisible: props.holdActions }}
        >
          {props.actions}
        </div>
      </Show>
    </div>
  );
}
