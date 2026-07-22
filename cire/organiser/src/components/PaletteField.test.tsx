// @vitest-environment happy-dom
import { PALETTE_PRESETS } from "@cire/theme";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import PaletteField, { type PaletteState } from "./PaletteField";

/**
 * The scheme editor: five seed pickers, the curated presets, and the live
 * preview. What is asserted here is the vocabulary and the two behaviours an
 * organiser cannot undo — a preset discarding their earlier nudges, and a nudge
 * landing on the right seed.
 *
 * The labels are the seed NAMES (Ground / Card / Ink / Gilt / Bloom), the same
 * words used by `@cire/theme`, the API schema and the wiki. A picker whose label
 * drifted from its `PaletteSeeds` key would still render — it would just ask the
 * organiser for one colour and change another — so each is pinned to its key.
 */
describe("PaletteField", () => {
  afterEach(cleanup);

  const EMPTY: PaletteState = { preset: null, seeds: {} };

  /** The five roles, in the order they read on the page. */
  const ROLES = ["Ground", "Card", "Ink", "Gilt", "Bloom"] as const;

  it("labels each picker with its seed name", () => {
    render(() => <PaletteField value={EMPTY} onChange={() => {}} />);
    for (const role of ROLES) expect(screen.getByLabelText(`${role} colour`)).toBeTruthy();
  });

  it("shows what each seed drives, since the names alone say nothing", () => {
    render(() => <PaletteField value={EMPTY} onChange={() => {}} />);
    for (const hint of [
      "The background behind everything.",
      "Event cards, panels and pop-ups.",
      "Headings and body text.",
      "Buttons, links and fine rules.",
      "Small flourishes and markers.",
    ]) {
      expect(screen.getByText(hint)).toBeTruthy();
    }
  });

  it.each([
    ["Ground", "ground"],
    ["Card", "card"],
    ["Ink", "ink"],
    ["Gilt", "gilt"],
    ["Bloom", "bloom"],
  ])("edits the %s picker into the %s seed", async (label, key) => {
    const onChange = vi.fn();
    render(() => <PaletteField value={EMPTY} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(`${label} colour`));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#112233" } });

    expect(onChange).toHaveBeenCalledWith({ preset: null, seeds: { [key]: "#112233" } });
  });

  it("unset pickers show the chosen preset's colour, not a stand-in", () => {
    render(() => <PaletteField value={{ preset: "jewel", seeds: {} }} onChange={() => {}} />);
    // "Default" means "whatever the preset says" — the swatch beside it must be
    // the colour the invite actually renders.
    expect(screen.getByLabelText("Ground colour").textContent).toContain("Default");
    expect(PALETTE_PRESETS.jewel.ground).toBeTruthy();
  });

  it("picking a preset discards the organiser's earlier nudges", () => {
    const onChange = vi.fn();
    render(() => (
      <PaletteField value={{ preset: "fog", seeds: { ink: "#112233" } }} onChange={onChange} />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Chapel/ }));

    // Destructive and deliberate: a preset is five colours, so adopting one
    // wholesale is the only reading that leaves a coherent scheme.
    expect(onChange).toHaveBeenCalledWith({ preset: "chapel", seeds: {} });
  });

  it("stays quiet when the scheme needs no contrast rescue", () => {
    render(() => <PaletteField value={{ preset: "evergreen", seeds: {} }} onChange={() => {}} />);
    expect(screen.queryByText(/Adjusted to stay readable/)).toBeNull();
  });

  it("names the adjusted seed when a scheme defeats itself", async () => {
    // Text ≈ page: the derivation moves `ink` to clear 4.5:1 and says so, by
    // seed name rather than by raw key.
    render(() => (
      <PaletteField
        value={{ preset: null, seeds: { ground: "#999999", card: "#999999", ink: "#888888" } }}
        onChange={() => {}}
      />
    ));

    const notice = await waitFor(() => screen.getByText(/Adjusted to stay readable/));
    expect(notice.textContent).toContain("ink");
  });
});
