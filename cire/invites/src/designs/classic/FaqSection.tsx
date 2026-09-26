/**
 * Classic's FAQ section: the header on the events' centred column, the
 * questions under it, on the events section's surface. Loaded lazily by
 * `InvitePage` (see its `FaqSection` import), so it costs nothing on an invite
 * with no FAQ and nothing before a household claims.
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
      class="border-border border-b px-6 py-16 md:px-8 md:py-20"
      style={{ ...props.themeVars, "background-color": "var(--invite-section-bg)" }}
    >
      <div class="max-w-column-lg md:max-w-column-xl mx-auto text-center">
        <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 uppercase">
          {FAQ_EYEBROW}
        </p>
        <h2
          id={FAQ_HEADING_ID}
          class="font-display text-text leading-ui-none mb-8 text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]"
        >
          {FAQ_HEADING}
        </h2>
        <FaqList entries={props.entries} class="border-border border-y" />
      </div>
    </section>
  );
}
