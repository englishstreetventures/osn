// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import ColorPicker from "./ColorPicker";

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

  it("commits shorthand on blur via Kobalte's normalisation to the full hex", async () => {
    const onChange = vi.fn();
    render(() => <ColorPicker label="Accent" value="#d4af37" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Accent colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#1a2" } });
    expect(onChange).not.toHaveBeenCalled();

    // Leaving the field expands the shorthand ("#1a2" → "#11AA22") and commits it.
    fireEvent.blur(hex);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("#11AA22"));
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
