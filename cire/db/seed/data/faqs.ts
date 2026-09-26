// The sample wedding's FAQ section. Consumed only by cire/db/seed/generate.ts.
//
// Three entries so the dev tier shows the section under the events on a claimed
// invite, and the builder's list has something to reorder. The section's switch
// is left at its column default (on).
//
// `sortOrder` is dense from 0, which is what the reorder endpoint writes.

export type SeedFaq = {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly sortOrder: number;
};

const faq = (n: number): string => `faq_2c9e7a41-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const faqs = [
  {
    id: faq(1),
    question: "Is there parking at the venue?",
    answer:
      "Yes. The venue has free parking for about sixty cars, and the overflow lot is a two-minute walk from the main entrance.",
    sortOrder: 0,
  },
  {
    id: faq(2),
    question: "Are children invited?",
    answer:
      "We love your little ones, but the reception is adults only. Children named on your invitation are very welcome at the ceremony.",
    sortOrder: 1,
  },
  {
    id: faq(3),
    question: "When should we arrive?",
    answer:
      "Please arrive twenty minutes before the ceremony starts. The doors close five minutes before, so the couple can walk in to a full room.",
    sortOrder: 2,
  },
] as const satisfies readonly SeedFaq[];
