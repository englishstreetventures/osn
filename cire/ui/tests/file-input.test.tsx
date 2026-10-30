// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { CONTROL_HEIGHT } from "@shared/ui/ui/control";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { buttonLook } from "../src/button";
import FileInput, { FILE_BUTTON } from "../src/file-input";

/**
 * `FileInput`: the props a picker's call sites rely on reach the input, and
 * its button is `quiet` at `md`, held to `Button`'s own classes so a change to
 * either cannot leave the picker behind.
 */

afterEach(cleanup);

/** `base:hover:x` → `base:enabled:hover:file:x`; `base:x` → `base:file:x`. */
function onFileButton(utility: string): string {
  const parts = utility.split(":");
  const last = parts.pop()!;
  const states = parts.slice(1);
  const lead = states.includes("hover") ? ["base", "enabled", ...states] : ["base", ...states];
  return [...lead, "file", last].join(":");
}

describe("FileInput", () => {
  it("is a file input that hands every prop it is given to the input", () => {
    let ref: HTMLInputElement | undefined;
    const { container } = render(() => (
      <>
        <span id="hint">CSV or spreadsheet</span>
        <FileInput
          ref={ref}
          accept=".csv,.xlsx"
          multiple
          name="guests"
          id="guest-file"
          disabled
          aria-label="Guest list"
          aria-describedby="hint"
          aria-invalid="true"
        />
      </>
    ));
    const input = container.querySelector("input")!;
    expect(input).toBe(ref);
    expect(input.type).toBe("file");
    expect([input.accept, input.multiple, input.name, input.id, input.disabled]).toEqual([
      ".csv,.xlsx",
      true,
      "guests",
      "guest-file",
      true,
    ]);
    expect(input).toHaveAccessibleName("Guest list");
    expect(input).toHaveAccessibleDescription("CSV or spreadsheet");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("carries the button's classes, and a caller's layout class after them", () => {
    const { container } = render(() => (
      <>
        <FileInput aria-label="Bare" />
        <FileInput aria-label="Placed" class="w-full" />
      </>
    ));
    const [bare, placed] = [...container.querySelectorAll("input")];
    const own = bare!.className.split(" ");
    for (const c of FILE_BUTTON.split(/\s+/)) expect(own).toContain(c);
    expect(own.every((c) => c.startsWith("base:"))).toBe(true);
    expect(placed!.className).toBe(`${bare!.className} w-full`);
  });

  it("calls onChange with the input as the event's target", () => {
    let target: EventTarget | null = null;
    const { container } = render(() => (
      <FileInput aria-label="Picture" onChange={(e) => (target = e.currentTarget)} />
    ));
    const input = container.querySelector("input")!;
    fireEvent.change(input);
    expect(target).toBe(input);
  });
});

describe("FILE_BUTTON", () => {
  it("is quiet at md, utility for utility, at the form-field height, and nothing more", () => {
    const { variant, size } = buttonLook({ variant: "quiet", size: "md" });
    // Every class of the variant and the size, on the file button. `py-2` gives
    // way to the fixed height.
    const fromButton = [...variant.split(/\s+/), ...size.split(/\s+/)]
      .filter((c) => c !== "base:py-2")
      .map(onFileButton);
    // What a button beside a file name needs that `quiet` and `md` do not say:
    // an edge and no fill, the pill corner and body face every `Button` takes,
    // the field height, a gap before the name, the cursor for each state, and
    // `Button`'s fade, stopped under reduced motion.
    const extras = [
      "base:file:border",
      "base:file:bg-transparent",
      "base:file:rounded-ui-control",
      "base:file:font-ui-body",
      "base:file:py-0",
      CONTROL_HEIGHT.form.replace("base:", "base:file:"),
      "base:file:mr-3",
      "base:enabled:file:cursor-pointer",
      "base:disabled:file:cursor-not-allowed",
      "base:file:transition-[color,background-color,border-color,text-decoration-color]",
      "base:file:duration-(--dur-fast,100ms)",
      "base:file:ease-out",
      "base:motion-reduce:file:transition-none",
    ];
    expect(new Set(FILE_BUTTON.split(/\s+/))).toEqual(new Set([...fromButton, ...extras]));
  });
});
