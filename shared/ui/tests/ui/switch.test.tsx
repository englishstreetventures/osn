// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Switch } from "../../src/ui/switch";

/**
 * The switch is controlled: it shows `checked` and asks for a change through
 * `onChange`. What this tier can check is the wiring — the role, the state a
 * screen reader hears, which gestures ask for a change and which states refuse
 * one. Whether the thumb actually moves is paint, and lives in
 * `switch.browser.test.tsx`.
 */

afterEach(() => cleanup());

const control = () => screen.getByRole("switch");

describe("Switch", () => {
  it("is a named switch carrying its state", () => {
    render(() => <Switch checked label="Allow plus-ones" />);
    expect(control().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Allow plus-ones" })).toBe(control());
  });

  it("keeps a hidden label as the accessible name", () => {
    render(() => <Switch checked={false} label="Ada may bring a plus-one" labelHidden />);
    const label = screen.getByText("Ada may bring a plus-one");
    expect(label.className).toContain("sr-only");
    expect(screen.getByRole("switch", { name: "Ada may bring a plus-one" })).toBeTruthy();
  });

  it("asks for the opposite value on a click and moves only when the caller agrees", () => {
    const onChange = vi.fn();
    const [on, setOn] = createSignal(false);
    render(() => (
      <Switch
        checked={on()}
        label="Allow"
        onChange={(next) => {
          onChange(next);
          setOn(next);
        }}
      />
    ));
    fireEvent.click(control());
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(control().getAttribute("aria-checked")).toBe("true");
  });

  it("snaps back when the caller does not change `checked`", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={false} label="Allow" onChange={onChange} />);
    fireEvent.click(control());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(control().getAttribute("aria-checked")).toBe("false");
    expect((control() as HTMLInputElement).checked).toBe(false);
  });

  it("toggles from the track as well as the hidden input", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Switch checked={false} label="Allow" onChange={onChange} />
    ));
    const track = container.querySelector("[id$='-control']") as HTMLElement;
    fireEvent.click(track);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("read-only: announces it, refuses a change, and stays in the tab order", () => {
    const onChange = vi.fn();
    render(() => <Switch checked label="Allow" readOnly onChange={onChange} />);
    const input = control() as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-readonly")).toBe("true");
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-checked")).toBe("true");
  });

  it("busy: announces it and refuses a second change while the first is saving", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={false} label="Allow" busy onChange={onChange} />);
    const input = control() as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(input.disabled).toBe(false);
  });

  it("carries no aria-busy while idle", () => {
    render(() => <Switch checked={false} label="Allow" />);
    expect(control().hasAttribute("aria-busy")).toBe(false);
  });

  it("disabled: leaves the tab order and refuses a change", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={false} label="Allow" disabled onChange={onChange} />);
    const input = control() as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.disabled).toBe(true);
  });

  it("passes its name to the input and its class to the root", () => {
    const { container } = render(() => (
      <Switch checked label="Allow" name="plus-one" class="justify-end" />
    ));
    expect((control() as HTMLInputElement).name).toBe("plus-one");
    expect((container.firstElementChild as HTMLElement).className).toContain("justify-end");
  });

  it("points at a description it is given", () => {
    render(() => (
      <>
        <p id="why">Only editors can change this.</p>
        <Switch checked={false} label="Allow" describedBy="why" />
      </>
    ));
    expect(control().getAttribute("aria-describedby")).toContain("why");
  });
});
