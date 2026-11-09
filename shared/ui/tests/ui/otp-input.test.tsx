// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, afterEach, vi } from "vitest";

import { OtpInput } from "../../src/ui/otp-input";

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

  // The value has no gaps, so removing a digit moves every later one a box
  // left, as deleting a character does in a text field.
  it("Backspace on a filled box removes its digit and moves the later digits one box left", () => {
    const { onChange } = renderOtp("12");
    fireEvent.keyDown(digit(1), { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith("2");
    expect([digit(1).value, digit(2).value]).toEqual(["2", ""]);
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

  it("marks every box invalid while the status is error, and no box otherwise", () => {
    const [status, setStatus] = createSignal<"idle" | "error" | "verifying" | "accepted">("error");
    render(() => <OtpInput value="123456" onChange={() => {}} status={status()} />);
    const invalid = () => [1, 2, 3, 4, 5, 6].map((n) => digit(n).getAttribute("aria-invalid"));
    expect(invalid()).toEqual(Array(6).fill("true"));
    for (const next of ["idle", "verifying", "accepted"] as const) {
      setStatus(next);
      expect([next, invalid()]).toEqual([next, Array(6).fill(null)]);
    }
  });

  it("hands the caller's description ids to every box", () => {
    render(() => <OtpInput value="" onChange={() => {}} aria-describedby="code-error code-hint" />);
    for (let i = 1; i <= 6; i++) {
      expect(digit(i).getAttribute("aria-describedby")).toBe("code-error code-hint");
    }
  });

  // Every caller's own tests, and the sign-up E2E flows, find the boxes by these
  // names, so a caller that passes no label has to get exactly today's.
  it("keeps the fixed names when no label is passed", () => {
    render(() => <OtpInput value="" onChange={() => {}} />);
    const group = screen.getByRole("group");
    expect(group.getAttribute("aria-label")).toBe("Verification code");
    const named = [group, ...group.querySelectorAll("input")];
    expect(named.filter((el) => el.hasAttribute("aria-labelledby"))).toEqual([]);
    for (let i = 1; i <= 6; i++) {
      expect(digit(i).getAttribute("aria-label")).toBe(`Digit ${i}`);
    }
  });

  // A call site that names the boxes from its own label keeps every test that
  // finds them by digit: testing-library matches the `aria-label` attribute as
  // well as the `aria-labelledby` text.
  it("still finds each box by its digit name when a label is passed", () => {
    render(() => (
      <div>
        <span id="code-label">Email code</span>
        <OtpInput value="" onChange={() => {}} aria-labelledby="code-label" />
      </div>
    ));
    const byPattern = screen.getAllByLabelText(/^Digit \d$/);
    expect(byPattern).toHaveLength(6);
    for (let i = 1; i <= 6; i++) {
      expect(digit(i)).toBe(byPattern[i - 1]);
    }
  });
});
