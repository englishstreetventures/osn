// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import ColorPicker from "../../src/components/ColorPicker";

/**
 * ColorPicker is the popover swatch + visual area/hue picker + labelled "Hex"
 * field that replaced the bare native `<input type="color">`. It must keep the
 * `onChange(string | null)` hex contract intact: emit a `#rrggbb` string on a
 * valid pick, `null` on "Use default", and never emit a partial/invalid hex.
 */
describe("ColorPicker", () => {
  afterEach(cleanup);

  it("renders a labelled swatch trigger and shows the current hex", () => {
    render(() => <ColorPicker label="Accent" value="#112233" onChange={() => {}} />);
    const trigger = screen.getByLabelText("Accent colour");
    expect(trigger).toBeTruthy();
    // The trigger surfaces the hex value as text (uppercased) so it's legible.
    expect(trigger.textContent?.toUpperCase()).toContain("#112233");
  });

  it("renders an oklch value as its hex equivalent", async () => {
    // Kobalte's parser does NOT understand oklch(), and every curated preset
    // seed and derived token is oklch — so before the shared parser was wired in
    // here, each picker silently showed the stand-in gold instead of the colour
    // the invite actually renders. This is the normal path (open a swatch on a
    // preset), not an edge case.
    render(() => (
      <ColorPicker label="Accent" value="oklch(74.99% 0.0854 82.08)" onChange={() => {}} />
    ));
    const trigger = screen.getByLabelText("Accent colour");
    // The built-in gold converts to #C9A96E. Note it is NOT the picker's own
    // stand-in #D4AF37 — those two golds were always different, which is why a
    // silent fallback to the stand-in was invisible before this conversion
    // existed. Pinning the exact value is what makes that visible.
    expect(trigger.textContent?.toUpperCase()).toContain("#C9A96E");
    expect(trigger.textContent?.toUpperCase()).not.toContain("DEFAULT");

    fireEvent.click(trigger);
    const hex = (await waitFor(() => screen.getByLabelText("Hex"))) as HTMLInputElement;
    expect(hex.value.toUpperCase()).toBe("#C9A96E");
  });

  it("shows the caller's fallback colour when the value is null", () => {
    // "Default" must be a colour the organiser can SEE — the scheme editor
    // passes the seed's value in the chosen preset, so the swatch shows what the
    // invite actually paints rather than a stand-in.
    const { container } = render(() => (
      <ColorPicker
        label="Page"
        value={null}
        fallback="oklch(19.96% 0.0331 147.34)"
        onChange={() => {}}
      />
    ));
    // Still reads "Default" (nothing is persisted)…
    expect(screen.getByLabelText("Page colour").textContent).toContain("Default");
    // …but the swatch is painted with the fallback, not the stand-in gold.
    const swatch = container.querySelector('[aria-label="Page colour"] [style*="background"]');
    expect(swatch).not.toBeNull();
    const style = (swatch as HTMLElement).getAttribute("style") ?? "";
    expect(style.toLowerCase()).not.toContain("#d4af37");
  });

  it("falls back to the stand-in when neither the value nor the fallback parses", () => {
    render(() => (
      <ColorPicker label="Accent" value={null} fallback="rebeccapurple" onChange={() => {}} />
    ));
    expect(screen.getByLabelText("Accent colour").textContent).toContain("Default");
  });

  it("shows 'Default' (not a hex) and no clear control when value is null", () => {
    render(() => <ColorPicker label="Accent" value={null} onChange={() => {}} />);
    expect(screen.getByLabelText("Accent colour").textContent).toContain("Default");
    expect(screen.queryByText("Use default")).toBeNull();
  });

  it("emits a hex string when a full hex is typed into the labelled Hex field", async () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#112233" } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("#112233"));
  });

  it("does not emit while the typed hex is still partial/invalid", async () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    // Partial hex — three of six digits. Must not escape upstream.
    fireEvent.input(hex, { target: { value: "#11" } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts a bare 6-digit hex pasted without the leading '#'", async () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value={null} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    // Design tools often copy hex without the hash — the commit path prepends it.
    fireEvent.input(hex, { target: { value: "d4af37" } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("#D4AF37"));
  });

  it("does not emit 3/4-digit shorthand while the organiser is still typing", async () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    // "#d4a" is valid 3-digit shorthand (#DD44AA) but here it's just the first
    // three digits of "#d4af37". Committing it would hijack the colour mid-typing.
    fireEvent.input(hex, { target: { value: "#d4a" } });
    fireEvent.input(hex, { target: { value: "#d4af" } });
    expect(onChange).not.toHaveBeenCalled();

    // The full 6-digit value commits as normal.
    fireEvent.input(hex, { target: { value: "#d4af37" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("#D4AF37"));
  });

  it("restores the committed colour when the field is left mid-typing", async () => {
    // The regression this guards: Kobalte's ColorField ran its own blur handler
    // (composed unconditionally, so it could not be pre-empted) that parsed
    // whatever was in the field and wrote the expansion back — three digits into
    // "#d4af37" became "#DD44AA" and committed the moment focus moved. Leaving a
    // half-typed entry must never invent a colour.
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#1a2" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(hex);
    expect(onChange).not.toHaveBeenCalled();
    // The field goes back to the colour the invite is actually painted with.
    await waitFor(() => expect(hex.value.toUpperCase()).toBe("#D4AF37"));
  });

  it("re-prints a committed hex in canonical form on blur", async () => {
    // Value is signal-backed so the parent reflects the commit, as the builder
    // does — otherwise the re-seed effect pulls the field back to the stale prop
    // and the blur behaviour under test is never reached.
    const [value, setValue] = createSignal<string | null>("#d4af37");
    const onChange = vi.fn(setValue);
    render(() => <ColorPicker label="Accent" value={value()} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "11aa22" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("#11AA22"));

    // Blur is a no-op on the value — it only tidies the hash and the casing.
    fireEvent.blur(hex);
    await waitFor(() => expect(hex.value.toUpperCase()).toBe("#11AA22"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("says so when it discards an incomplete entry", async () => {
    // Snapping the field back is visible to anyone watching it and invisible to
    // everyone else (C-L3). A discard must be perceivable programmatically too,
    // or a screen-reader user leaves the field believing their colour applied.
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#1a2" } });
    expect(hex.getAttribute("aria-invalid")).toBeNull();

    fireEvent.blur(hex);
    const note = await waitFor(() => screen.getByText(/Needs 6 digits/));
    // Named as the field's description, so it is read with the input rather
    // than stranded as loose text beside it.
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    expect(hex.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.textContent).toContain("#D4AF37");

    // Typing again clears it — it describes an edit already moved on from.
    fireEvent.input(hex, { target: { value: "#1a22" } });
    await waitFor(() => expect(screen.queryByText(/Needs 6 digits/)).toBeNull());
    expect(hex.getAttribute("aria-invalid")).toBeNull();
  });

  it("stays silent when a complete entry is committed and then left", async () => {
    const [value, setValue] = createSignal<string | null>("#d4af37");
    render(() => <ColorPicker label="Accent" value={value()} onChange={setValue} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#11aa22" } });
    fireEvent.blur(hex);

    expect(screen.queryByText(/Needs 6 digits/)).toBeNull();
    expect(hex.getAttribute("aria-invalid")).toBeNull();
  });

  it("refuses a keystroke that cannot belong to a hex code", async () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);

    // A seventh digit, and a non-hex letter: both put the field straight back.
    fireEvent.input(hex, { target: { value: "#d4af371" } });
    expect(hex.value.toUpperCase()).toBe("#D4AF37");
    fireEvent.input(hex, { target: { value: "#d4af3z" } });
    expect(hex.value.toUpperCase()).toBe("#D4AF37");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits null when 'Use default' is clicked", () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#112233" onChange={onChange} />);
    fireEvent.click(screen.getByText("Use default"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("reflects an external value change on the trigger", async () => {
    const [value, setValue] = createSignal<string | null>("#112233");
    render(() => <ColorPicker label="Accent" value={value()} onChange={() => {}} />);
    expect(screen.getByLabelText("Accent colour").textContent?.toUpperCase()).toContain("#112233");

    setValue("#abcdef");
    await waitFor(() =>
      expect(screen.getByLabelText("Accent colour").textContent?.toUpperCase()).toContain(
        "#ABCDEF",
      ),
    );
  });
});
