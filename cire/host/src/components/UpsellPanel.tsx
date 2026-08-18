import type { Component } from "solid-js";

interface UpsellPanelProps {
  feature: "vendors" | "registry";
}

const COPY = {
  vendors: {
    title: "Vendors & directory",
    blurb: "Browse trusted wedding vendors and manage your shortlist in one place.",
  },
  registry: {
    title: "Gift registry",
    blurb: "List the gifts you'd like, and see what guests have claimed and sent.",
  },
} satisfies Record<UpsellPanelProps["feature"], { title: string; blurb: string }>;

/**
 * Upsell panel shown in place of a locked module (Phase 1: vendors, registry).
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
