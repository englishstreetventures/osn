/**
 * The FAQ section's pieces both design packs share: its fixed header copy and
 * the list of questions. Each pack draws its own section around the list — the
 * header, the alignment and the rule come from the pack, as they do for the
 * events above it. The guard every entry passes first is `faq-entries.ts`.
 *
 * Only the packs' lazily loaded `FaqSection` modules import this, so none of it
 * is in the page's first-load chunk: it renders only after a household claims,
 * and only on an invite that has a FAQ.
 *
 * The questions and answers are organiser-written free text. They render as
 * text nodes only (Solid escapes them); nothing here parses markup or links.
 */

import { For } from "solid-js";

import type { FaqEntry } from "./types";

/** The section's eyebrow and heading. Fixed copy, not an organiser field; the
 *  builder's preview mirrors them (`DEFAULTS` in cire/host's invite model). */
export const FAQ_EYEBROW = "Good to Know";
export const FAQ_HEADING = "Questions & Answers";

/** The heading's id, for the section's `aria-labelledby`. One FAQ per page. */
export const FAQ_HEADING_ID = "invite-faq-heading";

/**
 * The questions, each a native disclosure: the question is the `<summary>`,
 * the answer opens beneath it. `<details>` is reachable and operable from the
 * keyboard (Enter or Space on the summary) with no script, and announces its
 * expanded state itself. The question is not a heading: a heading inside a
 * `<summary>` loses its heading role in several screen readers, and the
 * section's own `<h2>` already names the list.
 *
 * `class` sets the list's outer rules, which differ by pack.
 */
export function FaqList(props: { entries: readonly FaqEntry[]; class?: string }) {
  return (
    <div data-faq-list class={`divide-border divide-y text-left ${props.class ?? ""}`}>
      <For each={props.entries}>
        {(entry) => (
          <details class="group" data-faq-item>
            <summary class="font-display text-text flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-4 text-xl font-normal break-words [&::-webkit-details-marker]:hidden">
              <span class="min-w-0">{entry.question}</span>
              <span
                aria-hidden="true"
                class="text-gold-ink shrink-0 text-2xl leading-none transition-transform duration-200 group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p class="font-body text-text-muted text-ui-base leading-ui-normal pb-5 break-words whitespace-pre-line">
              {entry.answer}
            </p>
          </details>
        )}
      </For>
    </div>
  );
}
