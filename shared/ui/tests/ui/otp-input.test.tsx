// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, afterEach, vi } from "vitest";

import { Input } from "../../src/ui/input";
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

  it("paste strips non-digits and caps at 6", () => {
    const { onChange } = renderOtp();
    fireEvent.paste(digit(1), {
      clipboardData: { getData: () => "12ab34cd5678" },
    });
    expect(onChange).toHaveBeenCalledWith("123456");
  });

  // A paste replaces the code, wherever it lands: it is never an insert at
  // the box it was pasted into.
  it("paste into a later box replaces the whole value", () => {
    const { onChange } = renderOtp("12");
    fireEvent.paste(digit(3), {
      clipboardData: { getData: () => "987654" },
    });
    expect(onChange).toHaveBeenCalledWith("987654");
    expect([1, 2, 3, 4, 5, 6].map((n) => digit(n).value)).toEqual(["9", "8", "7", "6", "5", "4"]);
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

  // The code boxes sit under the text fields in every auth form, so a change to
  // the text field's ring has to reach them too.
  it("draws the ground text field's focus ring", () => {
    render(() => (
      <div>
        <Input aria-label="Email" />
        <OtpInput value="" onChange={() => {}} />
      </div>
    ));
    const ring = [...screen.getByLabelText("Email").classList].filter((c) => c.includes("ring"));
    expect(ring.length).toBeGreaterThan(0);
    const box = digit(1).classList;
    expect(ring.filter((c) => !box.contains(c))).toEqual([]);
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
