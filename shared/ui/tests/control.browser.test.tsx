/**
 * The control box's sizes, fills and faces, measured where they are painted.
 *
 * Heights are fixed classes so no field's height depends on the platform's
 * font: each is measured here under a parent with a 20px font and a 2em line,
 * which would stretch a padding-made box. The ink fill's edge has to read as a
 * control's edge (3:1) on whatever the field sits on, so it is composited over
 * a light, a dark and a coloured ground and measured.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { ControlSize } from "../src/ui/control";
import { Input } from "../src/ui/input";
import { Select } from "../src/ui/select";
import { Textarea } from "../src/ui/textarea";

import "./test-support/tailwind.css";

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 800);
});

/** `--ui-focus` and `--ui-accent` in the test palette (`test-support/tailwind.css`). */
const FOCUS = "rgb(47, 75, 216)";
const ACCENT = "rgb(47, 75, 216)";

/** A parent that would stretch any box whose height comes from its padding. */
const TALL = { "font-size": "20px", "line-height": "2" } as const;

const height = (el: Element) => el.getBoundingClientRect().height;

/** The sRGB pixel a translucent colour paints over a ground, read back from a canvas. */
function composite(color: string, ground: string): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("heights", () => {
  const cases: [ControlSize, number][] = [
    ["sm", 28],
    ["md", 36],
    ["form", 34],
    ["form-compact", 34],
  ];

  it("gives Input and Select the same fixed height at each size, whatever the font", () => {
    render(() => (
      <div style={TALL}>
        {cases.map(([size]) => (
          <>
            <Input size={size} aria-label={`input ${size}`} />
            <Select size={size} aria-label={`select ${size}`}>
              <option>Catering</option>
            </Select>
          </>
        ))}
      </div>
    ));
    for (const [size, px] of cases) {
      const input = height(screen.getByRole("textbox", { name: `input ${size}` }));
      const select = height(screen.getByRole("combobox", { name: `select ${size}` }));
      expect([size, input, select]).toEqual([size, px, px]);
    }
  });

  it("makes a touch field 46px on a phone and 44px from 640px", async () => {
    await page.viewport(390, 800);
    render(() => (
      <div style={TALL}>
        <Input size="touch" aria-label="Your name" />
      </div>
    ));
    expect(height(screen.getByRole("textbox"))).toBe(46);
    await page.viewport(1280, 800);
    expect(height(screen.getByRole("textbox"))).toBe(44);
  });

  it("gives a textarea no fixed height, and top and bottom padding at a fixed-height size", () => {
    render(() => <Textarea size="touch" fill="ink" rows={4} aria-label="Note" />);
    const area = screen.getByRole("textbox");
    expect(height(area)).toBeGreaterThan(60);
    expect(Number.parseFloat(getComputedStyle(area).paddingTop)).toBeGreaterThan(0);
  });
});

describe("the ink fill", () => {
  it("sets 16px type on a phone and the base step from 640px, at normal tracking", async () => {
    await page.viewport(390, 800);
    render(() => (
      <div style={{ "letter-spacing": "0.16em" }}>
        <Input fill="ink" size="touch" aria-label="Your name" />
      </div>
    ));
    const field = screen.getByRole("textbox");
    expect(getComputedStyle(field).fontSize).toBe("16px");
    expect(["normal", "0px"]).toContain(getComputedStyle(field).letterSpacing);
    await page.viewport(1280, 800);
    expect(getComputedStyle(field).fontSize).toBe("14.4px");
  });

  it("draws an edge that reads at 3:1 on a light, a dark and a coloured ground", () => {
    // Three of the guest site's palettes (`cire/theme/src/palette.ts`): chapel's
    // cream, jewel's aubergine night and garden's blush, each with its own ink,
    // which is what the fill draws from.
    const grounds = [
      { ground: "oklch(94.5% 0.014 85)", ink: "oklch(28% 0.018 70)" },
      { ground: "oklch(19.5% 0.045 305)", ink: "oklch(95.5% 0.014 85)" },
      { ground: "oklch(93.5% 0.021 25)", ink: "oklch(30% 0.052 350)" },
    ];
    render(() => (
      <>
        {grounds.map((g, i) => (
          <div style={{ "--ui-ink": g.ink, background: g.ground }}>
            <Input fill="ink" aria-label={`field ${i}`} />
          </div>
        ))}
      </>
    ));
    grounds.forEach((g, i) => {
      const edge = getComputedStyle(
        screen.getByRole("textbox", { name: `field ${i}` }),
      ).borderTopColor;
      const painted = composite(edge, g.ground);
      const ground = composite(g.ground, g.ground);
      expect([g.ground, contrast(painted, ground) >= 3]).toEqual([g.ground, true]);
    });
  });

  it("focuses with the 2px outline 2px off and an accent edge, and fades no outline", async () => {
    render(() => <Input fill="ink" aria-label="Your name" />);
    const field = screen.getByRole("textbox");
    expect(getComputedStyle(field).transitionProperty).not.toMatch(/outline|all/);
    await userEvent.tab();
    const s = getComputedStyle(field);
    expect([s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor]).toEqual([
      "solid",
      "2px",
      "2px",
      FOCUS,
    ]);
    expect(s.boxShadow).toBe("none");
    // The edge fades to the accent over `--ui-dur-fast`; read it once settled.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getComputedStyle(field).borderTopColor).toBe(ACCENT);
  });
});

describe("Select's chevron", () => {
  it("sits 12px in on a wide box and 10px on a narrow one, clear of a long value", () => {
    render(() => (
      <>
        <Select size="form" aria-label="wide" class="w-48">
          <option>A very long category name that runs on</option>
        </Select>
        <Select size="sm" aria-label="narrow" class="w-48">
          <option>A very long sort order that runs on</option>
        </Select>
      </>
    ));
    for (const [name, inset, pad] of [
      ["wide", 12, 34],
      ["narrow", 10, 28],
    ] as const) {
      const select = screen.getByRole("combobox", { name });
      const s = getComputedStyle(select);
      const chevron = select.nextElementSibling!.getBoundingClientRect();
      const box = select.getBoundingClientRect();
      expect([
        name,
        s.appearance,
        s.paddingTop,
        s.paddingBottom,
        Number.parseFloat(s.paddingRight),
        box.right - chevron.right,
        chevron.width,
        // The value stops before the chevron starts.
        box.right - pad <= chevron.left,
      ]).toEqual([name, "none", "0px", "0px", pad, inset, 10, true]);
    }
  });

  it("shows its whole value when sized to its content in a squeezed row", () => {
    render(() => (
      <label style={{ display: "flex", width: "220px", gap: "8px" }}>
        <span style={{ flex: "1 1 auto", "min-width": "0" }}>A role for this co-host</span>
        <Select size="form-compact" aria-label="Role" class="w-auto">
          <option>Can edit everything</option>
        </Select>
      </label>
    ));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const s = getComputedStyle(select);
    const content =
      select.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
    const probe = document.createElement("span");
    probe.style.font = s.font;
    probe.textContent = "Can edit everything";
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    expect(content).toBeGreaterThanOrEqual(needed - 1);
  });

  it("lets the call site's class size the box the select fills, and dims the chevron when disabled", () => {
    render(() => (
      <Select size="form" aria-label="Role" class="w-40" disabled>
        <option>Co-host</option>
      </Select>
    ));
    const select = screen.getByRole("combobox");
    expect(select.getBoundingClientRect().width).toBe(160);
    expect(getComputedStyle(select.nextElementSibling!).opacity).toBe("0.5");
  });
});

describe("on a site whose root is 17px", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
  });

  it("grows a touch field and the claim code with the root, never under 44px", () => {
    document.documentElement.style.fontSize = "17px";
    render(() => (
      <>
        <Input fill="ink" size="touch" aria-label="Your name" />
        <Input fill="ink" size="touch" face="claim" aria-label="Invitation code" />
      </>
    ));
    expect(height(screen.getByRole("textbox", { name: "Your name" }))).toBe(46.75);
    expect(
      getComputedStyle(screen.getByRole("textbox", { name: "Invitation code" })).fontSize,
    ).toBe("17px");
  });
});

describe("faces", () => {
  it("sets the invitation code centred, in capitals, at 16px on every width", () => {
    render(() => (
      <Input fill="ink" size="touch" face="claim" aria-label="Invitation code" value="patel-joy" />
    ));
    const s = getComputedStyle(screen.getByRole("textbox"));
    // `text-base`, one rem at every width, as the claim field draws today.
    expect([s.textAlign, s.textTransform, s.fontSize]).toEqual(["center", "uppercase", "16px"]);
    expect(Number.parseFloat(s.letterSpacing)).toBeGreaterThan(0);
    expect(s.paddingLeft).toBe("16px");
  });

  it("sets an amount centred and nothing else", () => {
    render(() => <Input fill="ink" size="touch" face="amount" aria-label="Amount" value="150" />);
    const s = getComputedStyle(screen.getByRole("textbox"));
    expect([s.textAlign, s.textTransform]).toEqual(["center", "none"]);
  });
});
