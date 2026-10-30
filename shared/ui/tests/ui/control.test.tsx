// @vitest-environment happy-dom
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import {
  controlClass,
  type ControlFace,
  type ControlFill,
  type ControlSize,
} from "../../src/ui/control";
import { Input } from "../../src/ui/input";
import { Select } from "../../src/ui/select";
import { Textarea } from "../../src/ui/textarea";

/*
 * The class strings the control box hands to every app.
 *
 * musubi, the osn sign-in screens and pulse draw `Input` and `Textarea` with no
 * fill at `sm` and `md`; their look is these strings, so the strings are pinned
 * as they were before the fills, faces and form sizes arrived. The rest holds
 * the rule the module is built on: one class per property, because two
 * zero-specificity classes on one property are decided by stylesheet order.
 */

/** The ground fill's shared part, as it was. */
const BASE =
  "base:border-ui-hairline-strong base:bg-ui-ground base:text-ui-ink base:ring-offset-ui-ground base:placeholder:text-ui-ink-secondary base:w-full base:rounded-ui-field base:border base:focus-visible:ring-ui-focus base:focus-visible:outline-none base:focus-visible:ring-2 base:focus-visible:ring-offset-2 base:aria-[invalid=true]:border-ui-danger base:disabled:cursor-not-allowed base:disabled:opacity-50";

/** `controlClass(size, extra, face)` for every size, face and extra apps pass. */
const BEFORE: [ControlSize | null, ControlFace | null, string | null, string][] = [
  [null, null, null, BASE + " base:px-3 base:py-2 base:text-ui-base "],
  [null, null, "w-40", BASE + " base:px-3 base:py-2 base:text-ui-base  w-40"],
  [null, "text", null, BASE + " base:px-3 base:py-2 base:text-ui-base "],
  [null, "text", "w-40", BASE + " base:px-3 base:py-2 base:text-ui-base  w-40"],
  [
    null,
    "code",
    null,
    BASE + " base:px-3 base:py-2 base:text-ui-base base:font-ui-mono base:tracking-ui-wide",
  ],
  [
    null,
    "code",
    "w-40",
    BASE + " base:px-3 base:py-2 base:text-ui-base base:font-ui-mono base:tracking-ui-wide w-40",
  ],
  ["sm", null, null, BASE + " base:px-2 base:py-1 base:text-ui-sm "],
  ["sm", null, "w-40", BASE + " base:px-2 base:py-1 base:text-ui-sm  w-40"],
  ["sm", "text", null, BASE + " base:px-2 base:py-1 base:text-ui-sm "],
  ["sm", "text", "w-40", BASE + " base:px-2 base:py-1 base:text-ui-sm  w-40"],
  [
    "sm",
    "code",
    null,
    BASE + " base:px-2 base:py-1 base:text-ui-sm base:font-ui-mono base:tracking-ui-wide",
  ],
  [
    "sm",
    "code",
    "w-40",
    BASE + " base:px-2 base:py-1 base:text-ui-sm base:font-ui-mono base:tracking-ui-wide w-40",
  ],
  ["md", null, null, BASE + " base:px-3 base:py-2 base:text-ui-base "],
  ["md", null, "w-40", BASE + " base:px-3 base:py-2 base:text-ui-base  w-40"],
  ["md", "text", null, BASE + " base:px-3 base:py-2 base:text-ui-base "],
  ["md", "text", "w-40", BASE + " base:px-3 base:py-2 base:text-ui-base  w-40"],
  [
    "md",
    "code",
    null,
    BASE + " base:px-3 base:py-2 base:text-ui-base base:font-ui-mono base:tracking-ui-wide",
  ],
  [
    "md",
    "code",
    "w-40",
    BASE + " base:px-3 base:py-2 base:text-ui-base base:font-ui-mono base:tracking-ui-wide w-40",
  ],
];

/** The class attribute `Input` and `Textarea` rendered, by size and face or resize. */
const RENDERED: ["Input" | "Textarea", ControlSize | null, string | null, string][] = [
  [
    "Input",
    null,
    null,
    "base:flex base:h-9 base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium " +
      BASE +
      " base:px-3 base:py-2 base:text-ui-base ",
  ],
  [
    "Input",
    null,
    "code",
    "base:flex base:h-9 base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium " +
      BASE +
      " base:px-3 base:py-2 base:text-ui-base base:font-ui-mono base:tracking-ui-wide",
  ],
  [
    "Input",
    "sm",
    null,
    "base:flex base:h-7 base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium " +
      BASE +
      " base:px-2 base:py-1 base:text-ui-sm ",
  ],
  [
    "Input",
    "sm",
    "code",
    "base:flex base:h-7 base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium " +
      BASE +
      " base:px-2 base:py-1 base:text-ui-sm base:font-ui-mono base:tracking-ui-wide",
  ],
  [
    "Input",
    "md",
    null,
    "base:flex base:h-9 base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium " +
      BASE +
      " base:px-3 base:py-2 base:text-ui-base ",
  ],
  [
    "Input",
    "md",
    "code",
    "base:flex base:h-9 base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium " +
      BASE +
      " base:px-3 base:py-2 base:text-ui-base base:font-ui-mono base:tracking-ui-wide",
  ],
  [
    "Textarea",
    null,
    null,
    "base:flex base:min-h-15 " + BASE + " base:px-3 base:py-2 base:text-ui-base  base:resize-y",
  ],
  [
    "Textarea",
    null,
    "none",
    "base:flex base:min-h-15 " + BASE + " base:px-3 base:py-2 base:text-ui-base  base:resize-none",
  ],
  [
    "Textarea",
    "sm",
    null,
    "base:flex base:min-h-15 " + BASE + " base:px-2 base:py-1 base:text-ui-sm  base:resize-y",
  ],
  [
    "Textarea",
    "sm",
    "none",
    "base:flex base:min-h-15 " + BASE + " base:px-2 base:py-1 base:text-ui-sm  base:resize-none",
  ],
  [
    "Textarea",
    "md",
    null,
    "base:flex base:min-h-15 " + BASE + " base:px-3 base:py-2 base:text-ui-base  base:resize-y",
  ],
  [
    "Textarea",
    "md",
    "none",
    "base:flex base:min-h-15 " + BASE + " base:px-3 base:py-2 base:text-ui-base  base:resize-none",
  ],
];

describe("with no fill", () => {
  it("returns every string the apps had", () => {
    for (const [size, face, extra, expected] of BEFORE) {
      expect(controlClass(size ?? undefined, extra ?? undefined, face ?? undefined)).toBe(expected);
    }
  });

  it("renders Input and Textarea with the classes they had", () => {
    for (const [kind, size, option, expected] of RENDERED) {
      const { container, unmount } = render(() =>
        kind === "Input" ? (
          <Input size={size ?? undefined} face={(option as ControlFace | null) ?? undefined} />
        ) : (
          <Textarea size={size ?? undefined} resize={option === "none" ? "none" : undefined} />
        ),
      );
      expect(container.firstElementChild!.className).toBe(expected);
      unmount();
    }
  });
});

const SIZES: ControlSize[] = ["sm", "md", "form", "form-compact", "touch"];
const FACES: ControlFace[] = ["text", "code", "claim", "amount"];
const FILLS: ControlFill[] = ["ground", "ink"];

/** The classes in a string that set one property, by the utility's prefix. */
function setting(classes: string, property: RegExp): string[] {
  return classes
    .split(/\s+/)
    .filter(
      (c) => c.startsWith("base:") && !c.includes(":placeholder:") && !c.startsWith("base:file:"),
    )
    .map((c) => c.replace(/^base:(sm:)?/, ""))
    .filter((c) => property.test(c));
}

/** Checks one class string sets each of padding, type size and tracking at most once. */
function expectOnePerProperty(classes: string, where: string) {
  const c = classes
    .split(/\s+/)
    .filter((x) => !x.startsWith("base:sm:"))
    .join(" ");
  expect([where, setting(c, /^px-|^pl-/).length]).toEqual([where, 1]);
  expect([where, setting(c, /^py-/).length <= 1]).toEqual([where, true]);
  expect([where, setting(c, /^text-(base|ui-(xs|sm|base|md|lg))$/).length]).toEqual([where, 1]);
  expect([where, setting(c, /^tracking-/).length <= 1]).toEqual([where, true]);
}

describe("one class per property", () => {
  it("holds on the rendered Input, Textarea and Select at every size and fill", () => {
    for (const size of SIZES)
      for (const fill of FILLS) {
        const { container, unmount } = render(() => (
          <>
            <Input size={size} fill={fill} />
            <Textarea size={size} fill={fill} />
            <Select size={size} fill={fill}>
              <option>one</option>
            </Select>
          </>
        ));
        const fields = [...container.querySelectorAll("input, textarea, select")];
        expect(fields).toHaveLength(3);
        for (const el of fields)
          expectOnePerProperty(el.className, `${el.tagName} ${size} ${fill}`);
        unmount();
      }
  });

  it("never sets padding, type size or letter-spacing twice", () => {
    for (const size of SIZES)
      for (const face of FACES)
        for (const fill of FILLS) {
          const c = controlClass(size, undefined, face, fill)
            .split(/\s+/)
            .filter((x) => !x.startsWith("base:sm:"))
            .join(" ");
          const where = `${size} ${face} ${fill}`;
          expect([where, setting(c, /^px-/).length]).toEqual([where, 1]);
          expect([where, setting(c, /^py-/).length <= 1]).toEqual([where, true]);
          expect([where, setting(c, /^text-(base|ui-(xs|sm|base|md|lg))$/).length]).toEqual([
            where,
            1,
          ]);
          expect([where, setting(c, /^tracking-/).length <= 1]).toEqual([where, true]);
        }
  });
});

describe("the ink fill", () => {
  it("keeps the 16px floor below 640px and the base step above, at every size, but for the claim face", () => {
    for (const size of SIZES) {
      const c = controlClass(size, undefined, undefined, "ink").split(" ");
      expect([size, c.includes("base:text-base"), c.includes("base:sm:text-ui-base")]).toEqual([
        size,
        true,
        true,
      ]);
    }
  });

  it("draws from the ink, never the ground, and focuses with an outline", () => {
    const c = controlClass("touch", undefined, undefined, "ink").split(" ");
    expect(c).toContain("base:border-ui-ink/55");
    expect(c).toContain("base:bg-ui-ink/4.5");
    expect(c.some((x) => x.includes("bg-ui-ground") || x.includes("ring-offset"))).toBe(false);
  });

  it("keeps a face's own type and tracking: the claim code is 16px at every width", () => {
    const c = controlClass("touch", undefined, "claim", "ink").split(" ");
    expect(c).toContain("base:text-base");
    expect(c).not.toContain("base:sm:text-ui-base");
    expect(c).toContain("base:tracking-ui-wider");
    expect(c).not.toContain("base:tracking-ui-normal");
  });
});
