import { hasText } from "./invite-emptiness";
import type { FaqEntry } from "./types";

/**
 * The entries of a claim response's `faq`, keeping only those with a question
 * and an answer that are both strings and not blank. Copied field by field, so
 * nothing else in the payload rides into the page. A malformed entry is dropped
 * rather than failing the claim: the guard on the claim response does not check
 * the FAQ, so a newer or broken API cannot sign a household out through it.
 *
 * Kept apart from the section's markup (`InviteFaq.tsx`), which each pack loads
 * only once this has said there is something to show.
 */
export function faqEntries(value: unknown): FaqEntry[] {
  if (!Array.isArray(value)) return [];
  const out: FaqEntry[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    if (!("question" in item) || typeof item.question !== "string") continue;
    if (!("answer" in item) || typeof item.answer !== "string") continue;
    if (!hasText(item.question) || !hasText(item.answer)) continue;
    out.push({ question: item.question, answer: item.answer });
  }
  return out;
}
