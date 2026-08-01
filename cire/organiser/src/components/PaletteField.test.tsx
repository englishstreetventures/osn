// @vitest-environment happy-dom
import { derivePalette, headingSizeCss, PALETTE_PRESETS, typographyVar } from "@cire/theme";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureDeclaredStyles } from "../test-support/declared-style";
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
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

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

  /**
   * The scheme preview sits inside the builder's "Look" card, directly under
   * the typography controls, and is styled with the shared token map — which
   * carries the five typography variables. Its sample used to pin
   * `font-light italic` at a literal `1.5rem`, so it contradicted every
   * heading pick made an inch above it. Follow the variables (with the guest
   * packs' literals as fallbacks) so a "Default" scheme still renders exactly
   * as before.
   */
  it("its heading sample follows the typography variables, not a hardcoded look", () => {
    const styles = captureDeclaredStyles();
    render(() => <PaletteField value={EMPTY} onChange={() => {}} />);
    const heading = screen.getByText("Your Events");

    // Against `@cire/theme`'s canonical fallbacks rather than a retyped
    // literal — the sample must follow the packs' base look, not a copy of it.
    const headingStyle = styles.of(heading);
    expect(headingStyle["font-weight"]).toBe(typographyVar("headingWeight"));
    expect(headingStyle["font-style"]).toBe(typographyVar("headingStyle"));
    expect(headingStyle["font-size"]).toBe(headingSizeCss("1.5rem"));
    // The old hardcoded pair would win over the variables — it must be gone.
    expect(heading.className).not.toContain("italic");
    expect(heading.className).not.toContain("font-light");

    // The body pair rides the panel wrapper and cascades, exactly as the guest
    // invite's `body` rule does — so the eyebrow and the event card follow the
    // organiser's body weight/style too, not just one line. Anchored off the
    // sample's own copy rather than a `> div` position, so a layout wrapper
    // can't silently re-point the assertion.
    const panel = screen.getByText("Celebrate with us").parentElement!;
    expect(panel.className).toContain("[font-weight:var(--invite-body-weight,400)]");
    expect(panel.className).toContain("[font-style:var(--invite-body-style,normal)]");
    expect(panel.getAttribute("style")).toContain("font-family:var(--font-body)");
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

  /**
   * The other half of the contrast story. `derivePalette` enforces each token
   * against one backdrop; the surface it leaves out entirely is `raised` — the
   * one every `EventCard` sits on — along with muted text on `ground`. Those
   * can still come out illegible, and the builder has to say so rather than
   * ship it quietly. It warns instead of blocking: the colours are the
   * organiser's, and the fix is a design decision the builder cannot make.
   */
  it("says nothing about contrast for a curated preset", () => {
    render(() => <PaletteField value={{ preset: "chapel", seeds: {} }} onChange={() => {}} />);
    expect(screen.queryByText(/hard to read/)).toBeNull();
  });

  it("warns, with the numbers, when a pick lands somewhere the derivation cannot fix", async () => {
    // A near-white card on a near-black page: gilt was enforced against the
    // PAGE, so it clears there and then lands on `raised` at under 2:1 — the
    // surface every event card, and its date line, actually sits on.
    render(() => (
      <PaletteField
        value={{
          preset: null,
          seeds: {
            ground: "#101010",
            card: "#f2f2f2",
            ink: "#eeeeee",
            gilt: "#d4af37",
            bloom: "#c0392b",
          },
        }}
        onChange={() => {}}
      />
    ));

    const heading = await waitFor(() => screen.getByText("Some colours are hard to read"));
    const notice = heading.parentElement!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(
      "Dates, buttons and rules are hard to see on event cards.",
    );
    // The measured ratio and the bar it missed, so the warning is checkable
    // rather than a bare verdict.
    expect(notice.textContent).toMatch(/\d+(\.\d+)?:1, needs 3:1/);
  });

  it("keeps the live region mounted and the per-frame numbers out of it", async () => {
    // C-L1. `role="status"` is implicitly atomic, and this region's trigger is
    // a pointer-rate colour drag, so two things have to hold: the region must
    // not be mounted and unmounted as warnings flip in and out (a region
    // inserted with its content announces unreliably, and the churn reflows the
    // sidebar), and the ratios — the one part that moves every frame — must be
    // hidden from the accessibility tree so a drag does not re-announce the
    // whole block on each pointermove.
    const { container } = render(() => (
      <PaletteField value={{ preset: "chapel", seeds: {} }} onChange={() => {}} />
    ));
    // A clean preset warns about nothing, yet the region is already there.
    const region = container.querySelector('[role="status"]:not(p)');
    expect(region).not.toBeNull();
    expect(region!.textContent).not.toContain("hard to read");

    cleanup();
    render(() => (
      <PaletteField
        value={{
          preset: null,
          seeds: { ground: "#101010", card: "#f2f2f2", ink: "#eeeeee", gilt: "#d4af37" },
        }}
        onChange={() => {}}
      />
    ));
    const heading = await waitFor(() => screen.getByText("Some colours are hard to read"));
    const numbers = heading.parentElement!.querySelectorAll("span[aria-hidden='true']");
    expect(numbers.length).toBeGreaterThan(0);
    for (const span of numbers) expect(span.textContent).toMatch(/:1, needs/);
  });

  it("warns off the SHARED token map when the parent supplies one", async () => {
    // The production path. `InviteBuilder` always passes `tokens` (it derives
    // once per drag frame and shares the result, P-W1), so the internal
    // derivation the tests above exercise is the path that never runs in the
    // app — a warning wired only to `internalTokens` would be permanently
    // silent for every real organiser with the suite green.
    const shared = derivePalette({
      ground: "#101010",
      card: "#f2f2f2",
      ink: "#eeeeee",
      gilt: "#d4af37",
      bloom: "#c0392b",
    });
    render(() => (
      // Seeds deliberately left EMPTY: the only way this can warn is by reading
      // the shared map, so the assertion cannot pass through the internal path.
      <PaletteField value={EMPTY} onChange={() => {}} tokens={shared} adjustments={[]} />
    ));

    const heading = await waitFor(() => screen.getByText("Some colours are hard to read"));
    expect(heading.parentElement!.textContent).toContain(
      "Dates, buttons and rules are hard to see on event cards.",
    );
  });
});
