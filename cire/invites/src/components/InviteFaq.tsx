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

import Disclosure from "@cire/ui/disclosure";
import { For } from "solid-js";

import type { FaqEntry } from "./types";

/** The section's eyebrow and heading. Fixed copy, not an organiser field; the
 *  builder's preview mirrors them (`DEFAULTS` in cire/host's invite model). */
export const FAQ_EYEBROW = "Good to Know";
export const FAQ_HEADING = "Questions & Answers";

/** The heading's id, for the section's `aria-labelledby`. One FAQ per page. */
export const FAQ_HEADING_ID = "invite-faq-heading";

/**
 * The questions, each a `Disclosure` in its rule tone: the question is the
 * `<summary>`, the answer opens beneath it. A native `<details>`, so it is
 * reachable and operable from the keyboard (Enter or Space on the summary)
 * with no script, and announces its expanded state itself. The question is not
 * a heading: a heading inside a `<summary>` loses its heading role in several
 * screen readers, and the section's own `<h2>` already names the list. Its
 * words keep the regular weight whatever body weight the couple chose, as a
 * question to scan down.
 *
 * Each entry draws the rule under it, so the last one closes the list. `class`
 * adds the rule above the first, where a pack wants one.
 */
export function FaqList(props: { entries: readonly FaqEntry[]; class?: string }) {
  return (
    <div data-faq-list class={`text-left ${props.class ?? ""}`}>
      <For each={props.entries}>
        {(entry) => (
          <Disclosure tone="rule" summary={<span class="font-normal">{entry.question}</span>}>
            <p class="font-body text-text-muted text-ui-base leading-ui-normal break-words whitespace-pre-line">
              {entry.answer}
            </p>
          </Disclosure>
        )}
      </For>
    </div>
  );
}
