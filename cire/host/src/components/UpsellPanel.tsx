import type { Component } from "solid-js";

interface UpsellPanelProps {
  feature: "vendors";
}

const COPY: Record<UpsellPanelProps["feature"], { title: string; blurb: string }> = {
  vendors: {
    title: "Vendors & directory",
    blurb: "Browse trusted wedding vendors and manage your shortlist in one place.",
  },
};

/**
 * Upsell panel shown in place of a locked module (Phase 1: vendors only).
 * Pricing and checkout are deferred to Phase 2 — the CTA is intentionally
 * inert (`disabled`) so no price copy or payment flow is wired here.
 */
const UpsellPanel: Component<UpsellPanelProps> = (props) => {
  const copy = () => COPY[props.feature];
  return (
    <section class="upsell" aria-labelledby="upsell-title">
      <h2 id="upsell-title">{copy().title}</h2>
      <p>{copy().blurb}</p>
      {/* Phase 1: checkout not wired — inert CTA. Phase 2 enables it. */}
      <button type="button" disabled aria-disabled="true">
        Unlock — coming soon
      </button>
    </section>
  );
};

export default UpsellPanel;
