/**
 * Gala's FAQ section: the header on the events' leading-edge column, closed by
 * the same hairline rule, the questions under it, on the events section's
 * surface. Loaded lazily by `InvitePage` (see its `FaqSection` import), so it
 * costs nothing on an invite with no FAQ and nothing before a household claims.
 */
import { FAQ_EYEBROW, FAQ_HEADING, FAQ_HEADING_ID, FaqList } from "../../components/InviteFaq";
import type { FaqEntry } from "../../components/types";

export function FaqSection(props: {
  entries: readonly FaqEntry[];
  themeVars?: Record<string, string>;
}) {
  return (
    <section
      data-invite-faq
      aria-labelledby={FAQ_HEADING_ID}
      class="border-border border-b px-6 py-16 md:px-10 md:py-20"
      style={{ ...props.themeVars, "background-color": "var(--invite-section-bg)" }}
    >
      <div class="max-w-column-4xl mx-auto">
        <div class="max-w-column-2xl text-left">
          <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 uppercase">
            {FAQ_EYEBROW}
          </p>
          <h2
            id={FAQ_HEADING_ID}
            class="font-display text-text leading-ui-none mb-5 text-[calc(clamp(1.75rem,4vw,2.5rem)*var(--invite-heading-scale,1))] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]"
          >
            {FAQ_HEADING}
          </h2>
          <hr class="border-border mb-2 h-0 w-full border-t" aria-hidden="true" />
          <FaqList entries={props.entries} class="border-border border-b" />
        </div>
      </div>
    </section>
  );
}
