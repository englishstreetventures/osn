import { Schema } from "effect";

/**
 * The bounds on a wedding's FAQ section. One copy for the request schemas below
 * and the service's count cap; the organiser builder mirrors them in
 * `FAQ_CAPS` (`cire/host/src/components/invite/model.ts`).
 *
 *  - `maxEntries` — an invite FAQ past a couple of dozen questions stops being
 *    read, and every entry rides the claim response a household loads on each
 *    visit, so the list is kept short enough to stay cheap to send.
 *  - `questionMax` — one line on the invite.
 *  - `answerMax` — a short paragraph or two: parking directions, a note on
 *    children, the timing of the day.
 */
export const FAQ_LIMITS = {
  maxEntries: 30,
  questionMax: 200,
  answerMax: 1000,
} as const;

/**
 * Question or answer text as it arrives: at most `max` characters, and not
 * blank. The service stores it trimmed, so a question that is only spaces is
 * refused rather than stored as an empty line on the invite. The length bound
 * applies to the raw string, as the invite's copy fields do.
 */
const faqText = (max: number) =>
  Schema.String.check(
    Schema.isMaxLength(max),
    Schema.makeFilter((value: string) =>
      value.trim().length > 0 ? undefined : "Must not be blank",
    ),
  );

/** Body for `POST /invite/faqs` and `PUT /invite/faqs/:faqId`: both fields, always. */
export const FaqEntryBody = Schema.Struct({
  question: faqText(FAQ_LIMITS.questionMax),
  answer: faqText(FAQ_LIMITS.answerMax),
});
export type FaqEntryBody = Schema.Schema.Type<typeof FaqEntryBody>;

/**
 * Body for `PUT /invite/faqs/order`: the wedding's FAQ ids in their new order.
 * Bounded by the entry cap, which the insert enforces, so a full list always
 * fits.
 */
export const FaqOrderBody = Schema.Struct({
  orderedIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(FAQ_LIMITS.maxEntries)),
});
export type FaqOrderBody = Schema.Schema.Type<typeof FaqOrderBody>;
