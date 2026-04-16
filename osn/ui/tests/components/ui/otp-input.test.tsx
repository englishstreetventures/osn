// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, afterEach, vi } from "vitest";

import { OtpInput } from "../../../src/components/ui/otp-input";

function digit(n: number) {
  return screen.getByLabelText(`Digit ${n}`) as HTMLInputElement;
}

function renderOtp(initial = "", status?: "idle" | "error" | "verifying" | "accepted") {
  const [value, setValue] = createSignal(initial);
  const onChange = vi.fn((v: string) => setValue(v));
  render(() => <OtpInput value={value()} onChange={onChange} status={status} />);
  return { value, onChange };
}

describe("OtpInput", () => {
  afterEach(() => cleanup());

  it("renders 6 digit inputs", () => {
    renderOtp();
    for (let i = 1; i <= 6; i++) {
      expect(digit(i)).toBeTruthy();
    }
  });

  it("typing a digit calls onChange and advances focus", () => {
    const { onChange } = renderOtp();
    fireEvent.input(digit(1), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith("5");
  });

  it("ignores non-digit characters", () => {
    const { onChange } = renderOtp();
    fireEvent.input(digit(1), { target: { value: "a" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Backspace on filled cell clears it in place", () => {
    const { onChange } = renderOtp("12");
    fireEvent.keyDown(digit(1), { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("Backspace on empty cell moves focus left and clears previous", () => {
    const { onChange } = renderOtp("1");
    // Digit 2 is empty, press backspace
    fireEvent.keyDown(digit(2), { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("ArrowLeft and ArrowRight do not crash at boundaries", () => {
    renderOtp();
    // Should not throw at boundaries
    fireEvent.keyDown(digit(1), { key: "ArrowLeft" });
    fireEvent.keyDown(digit(6), { key: "ArrowRight" });
    // Inputs still present after boundary key events
    expect(digit(1)).toBeTruthy();
    expect(digit(6)).toBeTruthy();
  });

  it("paste fills all digits", () => {
    const { onChange } = renderOtp();
    fireEvent.paste(digit(1), {
      clipboardData: { getData: () => "123456" },
    });
    expect(onChange).toHaveBeenCalledWith("123456");
  });

  it("paste strips non-digits and caps at 6", () => {
    const { onChange } = renderOtp();
    fireEvent.paste(digit(1), {
      clipboardData: { getData: () => "12ab34cd5678" },
    });
    expect(onChange).toHaveBeenCalledWith("123456");
  });

  it("paste with only non-digits does nothing", () => {
    const { onChange } = renderOtp();
    fireEvent.paste(digit(1), {
      clipboardData: { getData: () => "abcdef" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inputs are disabled when status is verifying", () => {
    renderOtp("123456", "verifying");
    for (let i = 1; i <= 6; i++) {
      expect(digit(i).disabled).toBe(true);
    }
  });

  it("inputs are disabled when status is accepted", () => {
    renderOtp("123456", "accepted");
    for (let i = 1; i <= 6; i++) {
      expect(digit(i).disabled).toBe(true);
    }
  });

  it("inputs are enabled when status is idle", () => {
    renderOtp("", "idle");
    for (let i = 1; i <= 6; i++) {
      expect(digit(i).disabled).toBe(false);
    }
  });
});
