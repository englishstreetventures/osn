/**
 * `OtpInput` in real Chromium: what a DOM shim cannot see.
 *
 * - Geometry. Six boxes share the column's width and never pass 48px; the gaps
 *   close from 8px to 4px before the boxes shrink, so the boxes keep Musubi's
 *   40px touch floor down to a 260px column, the row fits a 320px phone, and a
 *   desktop row is unchanged.
 * - The empty box's edge reads at 3:1 on Musubi's light and dark grounds.
 * - Names and errors as Chrome hands them to a screen reader (its
 *   accessibility tree over CDP, the pattern in `tooltip.browser.test.tsx`).
 * - Focus. `autofocus` and the refocus after an error both wait one task and
 *   then focus box 1 only if it is enabled, because every caller disables the
 *   boxes and sets the state that asks for focus in the same synchronous run,
 *   and re-enables them in a `finally`. Inside a Kobalte dialog the wait also
 *   lets the dialog's own first-focus run first.
 * - Input. The value is a digit string with no gaps; typing over a digit
 *   replaces it; Backspace, Delete and cut remove one; an input that leaves the
 *   value as it was puts the box back; arrow keys move focus but never past the
 *   first empty box; an autofill of the whole code is taken whole.
 * - The focus mark: the text field's ring outside a contrast theme, and an
 *   outline the theme paints on the focused box only inside one.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import { Button } from "../src/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../src/ui/dialog";
import { Label } from "../src/ui/label";
import { Modal } from "../src/ui/modal";
import { OtpInput, type OtpStatus } from "../src/ui/otp-input";

import "./test-support/tailwind.css";

const emulateMedia = (options: { forcedColors: "active" | "none" }) =>
  (
    commands as unknown as {
      emulateMedia: (o: { forcedColors: "active" | "none" }) => Promise<void>;
    }
  ).emulateMedia(options);

interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
}

interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

/** Chrome's accessibility tree for the frame this test runs in. */
async function accessibilityTree(): Promise<AXNode[]> {
  const session = cdp();
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: Frame };
  const find = (node: Frame): Frame | undefined =>
    node.frame.url === location.href ? node : node.childFrames?.map(find).find(Boolean);
  const own = find(frameTree);
  if (!own) throw new Error(`no frame at ${location.href}`);
  const { nodes } = (await session.send("Accessibility.getFullAXTree", {
    frameId: own.frame.id,
  })) as { nodes: AXNode[] };
  return nodes.filter((node) => !node.ignored);
}

/** The six boxes, wherever they were rendered (a dialog portals them to `<body>`). */
function boxes(): HTMLInputElement[] {
  const found = [...screen.getByRole("group").querySelectorAll("input")];
  if (found.length !== 6) throw new Error(`expected 6 boxes, found ${found.length}`);
  return found;
}

const box = (n: number) => boxes()[n - 1]!;
const group = () => screen.getByRole("group");
const shown = () => boxes().map((b) => b.value);

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const task = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Two frames and two tasks: every 0ms timer queued by a mount or an effect has run. */
async function settle() {
  await frame();
  await frame();
  await task();
  await task();
}

/** A controlled OtpInput, as every caller writes it. */
function mountControlled(
  initial: string,
  extra: { status?: () => OtpStatus; disabled?: () => boolean; autofocus?: boolean } = {},
) {
  const [value, setValue] = createSignal(initial);
  const onChange = vi.fn((next: string) => setValue(next));
  render(() => (
    <div>
      <button type="button">Before</button>
      <OtpInput
        value={value()}
        onChange={onChange}
        status={extra.status?.()}
        disabled={extra.disabled?.()}
        autofocus={extra.autofocus}
      />
      <button type="button">After</button>
    </div>
  ));
  return { value, onChange };
}

/** A token's painted colour, as `getComputedStyle` writes a colour. */
function paint(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/** The sRGB pixel a colour paints over a ground, read back from a canvas. */
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

afterEach(async () => {
  await emulateMedia({ forcedColors: "none" });
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  cleanup();
  for (const p of document.querySelectorAll("[data-kb-top-layer]")) p.remove();
});

describe("OtpInput geometry", () => {
  it.each([
    { viewport: 320, column: "212px", host: "TotpView's enrol box in Settings" },
    { viewport: 390, column: "300px", host: "/authorize at 390" },
    { viewport: 320, column: "100%", host: "a full-width phone column" },
  ])("fits a $column column at a $viewport px viewport ($host)", async ({ viewport, column }) => {
    await page.viewport(viewport, 700);
    render(() => (
      <div style={{ width: column }}>
        <OtpInput value="123456" onChange={() => {}} />
      </div>
    ));
    const row = group();
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    const right = row.getBoundingClientRect().right;
    for (const b of boxes()) {
      expect(b.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
    }
  });

  it("keeps today's row in a 400px column: 48px squares, 8px apart, from the left edge", async () => {
    await page.viewport(1280, 800);
    render(() => (
      <div style={{ width: "400px" }}>
        <OtpInput value="" onChange={() => {}} />
      </div>
    ));
    const rects = boxes().map((b) => b.getBoundingClientRect());
    expect(rects.map((r) => [r.width, r.height])).toEqual(
      Array.from({ length: 6 }, () => [48, 48]),
    );
    const gaps = rects.slice(1).map((r, i) => r.left - rects[i]!.right);
    expect(gaps).toEqual(Array(5).fill(8));
    expect(rects[5]!.right - rects[0]!.left).toBe(328);
    expect(rects[0]!.left).toBe(group().getBoundingClientRect().left);
  });

  /** Each box's width and height, and the gaps between them, in a column of `width`. */
  async function rowIn(width: string) {
    await page.viewport(320, 700);
    render(() => (
      <div style={{ width }}>
        <OtpInput value="" onChange={() => {}} />
      </div>
    ));
    const rects = boxes().map((b) => b.getBoundingClientRect());
    return {
      widths: rects.map((r) => r.width),
      heights: rects.map((r) => r.height),
      gaps: rects.slice(1).map((r, i) => r.left - rects[i]!.right),
    };
  }

  it("closes the gaps before the boxes shrink: 48px boxes 6px apart in a 318px column", async () => {
    const { widths, gaps } = await rowIn("318px");
    expect(widths).toEqual(Array(6).fill(48));
    for (const gap of gaps) expect(gap).toBeCloseTo(6, 1);
  });

  // Musubi's touch floor (`musubi/social/DESIGN.md` §Responsive layout).
  it("keeps every box 40px wide and 48px tall in a 260px column, 4px apart", async () => {
    const { widths, heights, gaps } = await rowIn("260px");
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(40);
    expect(heights).toEqual(Array(6).fill(48));
    for (const gap of gaps) expect(gap).toBeCloseTo(4, 1);
  });

  // Under 260px a host has broken the touch floor; the row still fits, and
  // stays over WCAG's 24px minimum target.
  it("keeps every box 48px tall and 32px wide in a 212px column", async () => {
    const { widths, heights } = await rowIn("212px");
    expect(heights).toEqual(Array(6).fill(48));
    for (const width of widths) expect(width).toBeCloseTo(32, 1);
  });
});

describe("OtpInput edge", () => {
  // Musubi's light and dark palettes (`musubi/social/src/App.css`): the box is
  // filled with the ground, and the sign-up sheet around it is `--card`.
  const themes = [
    { theme: "light", ink: "#292929", ground: "#ffffff", around: "#ffffff" },
    { theme: "dark", ink: "#f2f2f2", ground: "#1c1c1c", around: "#242424" },
  ];

  it.each(themes)(
    "draws an empty box's edge at 3:1 against its fill and its surround ($theme)",
    ({ ink, ground, around }) => {
      render(() => (
        <div style={{ "--ui-ink": ink, "--ui-ground": ground, background: around }}>
          <OtpInput value="" onChange={() => {}} />
        </div>
      ));
      const edge = composite(getComputedStyle(box(1)).borderTopColor, ground);
      expect(contrast(edge, composite(ground, ground))).toBeGreaterThanOrEqual(3);
      expect(contrast(edge, composite(around, around))).toBeGreaterThanOrEqual(3);
    },
  );
});

describe("OtpInput names and errors", () => {
  it("names the group from the label and each box '<label> Digit N', even holding a digit", async () => {
    render(() => (
      <div>
        <Label id="otp-label">Email code</Label>
        <OtpInput value="5" onChange={() => {}} aria-labelledby="otp-label" />
      </div>
    ));
    const tree = await accessibilityTree();
    const groups = tree.filter((n) => n.role?.value === "group").map((n) => n.name?.value);
    expect(groups).toContain("Email code");
    const names = tree.filter((n) => n.role?.value === "textbox").map((n) => n.name?.value);
    expect(names).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Email code Digit ${n}`));
    // The lookup the sign-up E2E flows take once a call site passes a label.
    const located = page.getByRole("textbox", { name: "Email code Digit 1", exact: true });
    expect(located.element()).toBe(box(1));
  });

  it("hands Chrome the error: every box invalid, described by the caller's line, a danger border", async () => {
    render(() => (
      <div>
        <OtpInput value="123456" onChange={() => {}} status="error" aria-describedby="otp-err" />
        <p id="otp-err">Incorrect code</p>
      </div>
    ));
    const tree = await accessibilityTree();
    const first = tree.find((n) => n.role?.value === "textbox" && n.name?.value === "Digit 1");
    expect(first?.properties?.find((p) => p.name === "invalid")?.value.value).toBe("true");
    expect(first?.description?.value).toBe("Incorrect code");
    expect(getComputedStyle(box(1)).borderTopColor).toBe(paint("--ui-danger"));
  });
});

describe("OtpInput focus", () => {
  it("autofocus lands on box 1 when the boxes mount disabled and are enabled in the same run", async () => {
    const [disabled, setDisabled] = createSignal(true);
    mountControlled("", { disabled, autofocus: true });
    setDisabled(false);
    await settle();
    expect(document.activeElement).toBe(box(1));
  });

  it("autofocus lands on box 1 when the boxes mount verifying and go idle in the same run", async () => {
    const [status, setStatus] = createSignal<OtpStatus>("verifying");
    mountControlled("", { status, autofocus: true });
    setStatus("idle");
    await settle();
    expect(document.activeElement).toBe(box(1));
  });

  it("autofocus lands on box 1 inside a Kobalte dialog whose close button comes first", async () => {
    render(() => (
      <Dialog open>
        <DialogContent>
          <DialogTitle>Check your email</DialogTitle>
          <DialogClose>Close</DialogClose>
          <OtpInput value="" onChange={() => {}} autofocus />
        </DialogContent>
      </Dialog>
    ));
    await settle();
    expect(document.activeElement).toBe(box(1));
  });

  it("autofocus lands on box 1 inside a Modal whose close button comes first", async () => {
    render(() => (
      <Modal open onClose={() => {}} label="Check your email">
        <button type="button">Close</button>
        <OtpInput value="" onChange={() => {}} autofocus />
      </Modal>
    ));
    await settle();
    expect(document.activeElement).toBe(box(1));
  });

  // Register inside AuthDialogs: the focused submit button disables, the step
  // switches after an await, and busy clears in the same tick.
  it("autofocus lands on box 1 after a step switch inside an open dialog", async () => {
    function Steps() {
      const [step, setStep] = createSignal<"send" | "verify">("send");
      const [busy, setBusy] = createSignal(false);
      const [code, setCode] = createSignal("");
      async function send(e: SubmitEvent) {
        e.preventDefault();
        setBusy(true);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          setStep("verify");
        } finally {
          setBusy(false);
        }
      }
      return (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Create your account</DialogTitle>
            <Show
              when={step() === "verify"}
              fallback={
                <form onSubmit={send}>
                  <Button type="submit" disabled={busy()}>
                    Send code
                  </Button>
                </form>
              }
            >
              <OtpInput value={code()} onChange={setCode} disabled={busy()} autofocus />
            </Show>
          </DialogContent>
        </Dialog>
      );
    }
    render(() => <Steps />);
    await settle();
    const send = screen.getByRole("button", { name: "Send code" });
    await userEvent.click(send);
    await vi.waitFor(() => box(1));
    await settle();
    expect(document.activeElement).toBe(box(1));
  });

  it("leaves focus where it was when autofocus is not asked for", async () => {
    const before = document.createElement("button");
    before.textContent = "Elsewhere";
    document.body.append(before);
    before.focus();
    render(() => <OtpInput value="" onChange={() => {}} />);
    await settle();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("refocuses box 1 after an error that arrives while the boxes are still disabled", async () => {
    const [disabled, setDisabled] = createSignal(true);
    const [status, setStatus] = createSignal<OtpStatus>("verifying");
    mountControlled("123456", { status, disabled });
    // Register's order: the status, then busy cleared in a `finally`.
    setStatus("error");
    setDisabled(false);
    await settle();
    expect(document.activeElement).toBe(box(1));
  });
});

describe("OtpInput input", () => {
  it("after an error, a typed digit replaces box 1's, and a clicked box takes the next one", async () => {
    const [status, setStatus] = createSignal<OtpStatus>("idle");
    const { onChange } = mountControlled("123456", { status });
    setStatus("error");
    await settle();
    expect(document.activeElement).toBe(box(1));
    await userEvent.keyboard("9");
    expect(onChange).toHaveBeenLastCalledWith("923456");
    expect(box(1).value).toBe("9");
    await userEvent.click(box(3));
    await userEvent.keyboard("7");
    expect(onChange).toHaveBeenLastCalledWith("927456");
    expect(shown()).toEqual(["9", "2", "7", "4", "5", "6"]);
  });

  it("Delete on a filled box removes its digit and moves the later digits left", async () => {
    const { onChange } = mountControlled("123456");
    await userEvent.click(box(3));
    await userEvent.keyboard("{Delete}");
    expect(onChange).toHaveBeenLastCalledWith("12456");
    expect(shown()).toEqual(["1", "2", "4", "5", "6", ""]);
    expect(document.activeElement).toBe(box(3));
  });

  // Chrome's own Backspace would delete again from the box the handler has just
  // rewritten, taking a second digit.
  it("Backspace on a filled box removes its digit and moves the later digits left", async () => {
    const { onChange } = mountControlled("123456");
    await userEvent.click(box(3));
    await userEvent.keyboard("{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith("12456");
    expect(shown()).toEqual(["1", "2", "4", "5", "6", ""]);
    expect(document.activeElement).toBe(box(3));
  });

  it("Backspace on the first empty box removes the digit before it and moves there", async () => {
    const { onChange } = mountControlled("12");
    box(3).focus();
    await userEvent.keyboard("{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith("1");
    expect(shown()).toEqual(["1", "", "", "", "", ""]);
    expect(document.activeElement).toBe(box(2));
  });

  it("an input that leaves the value as it was puts the box's text back", async () => {
    const { onChange } = mountControlled("123");
    await userEvent.click(box(2));
    await userEvent.keyboard("2");
    expect(shown()).toEqual(["1", "2", "3", "", "", ""]);
    const calls = onChange.mock.calls.length;
    await userEvent.keyboard("a");
    expect(shown()).toEqual(["1", "2", "3", "", "", ""]);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it("arrow keys move focus a box at a time, never past the first empty box", async () => {
    mountControlled("123");
    box(2).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(box(1));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(box(1));
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(box(3));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(box(4));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(box(4));
  });

  // What Chrome fires after a cut empties the box. A real clipboard cut needs a
  // permission and a platform shortcut this tier does not have.
  it("a cut that empties a box removes its digit", async () => {
    const { onChange } = mountControlled("123456");
    const third = box(3);
    third.focus();
    third.value = "";
    third.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
    expect(onChange).toHaveBeenLastCalledWith("12456");
    expect(shown()).toEqual(["1", "2", "4", "5", "6", ""]);
  });

  it("a click past the first empty box puts focus there, and typing fills it", async () => {
    const { onChange } = mountControlled("12");
    await userEvent.click(box(4));
    expect(document.activeElement).toBe(box(3));
    await userEvent.keyboard("7");
    expect(onChange).toHaveBeenLastCalledWith("127");
    expect(shown()).toEqual(["1", "2", "7", "", "", ""]);
    expect(document.activeElement).toBe(box(4));
  });

  it("Tab from the first empty box leaves the group", async () => {
    mountControlled("12");
    box(3).focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("an autofill of the whole code into box 1 is taken whole", async () => {
    const { onChange } = mountControlled("");
    await userEvent.fill(box(1), "123456");
    expect(onChange).toHaveBeenLastCalledWith("123456");
    expect(shown()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(document.activeElement).toBe(box(6));
  });

  it("a password manager that sets box 1's value and fires input is taken whole", async () => {
    const { onChange } = mountControlled("");
    const first = box(1);
    first.value = "123456";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith("123456");
    expect(shown()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});

describe("OtpInput focus mark", () => {
  /** Tab onto box 1 from the button before it; read the mark at once and settled. */
  async function tabOnto(read: (el: Element) => unknown) {
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(box(1));
    expect(box(1).matches(":focus-visible")).toBe(true);
    const now = read(box(1));
    for (const animation of document.getAnimations()) animation.finish();
    return { now, settled: read(box(1)) };
  }

  it("draws the text field's ring in --ui-focus, 2px off the ground, and no outline", async () => {
    mountControlled("");
    const focus = paint("--ui-focus");
    const ground = paint("--ui-ground");
    const { now, settled } = await tabOnto((el) => {
      const style = getComputedStyle(el);
      return { outline: style.outlineStyle, shadow: style.boxShadow };
    });
    expect(settled).toEqual(now);
    const { outline, shadow } = now as { outline: string; shadow: string };
    expect(outline).toBe("none");
    expect(shadow).toContain(`${ground} 0px 0px 0px 2px`);
    expect(shadow).toContain(`${focus} 0px 0px 0px 4px`);
  });

  it("in a contrast theme, outlines the focused box and no other", async () => {
    await emulateMedia({ forcedColors: "active" });
    mountControlled("123456");
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    const { now, settled } = await tabOnto((el) => {
      const style = getComputedStyle(el);
      return [style.outlineStyle, style.outlineWidth, style.outlineOffset];
    });
    expect(now).toEqual(["solid", "2px", "2px"]);
    expect(settled).toEqual(now);
    const colour = getComputedStyle(box(1)).outlineColor;
    expect(colour).not.toMatch(/^rgba\(.*,\s*0\)$/);
    for (const other of boxes().slice(1)) {
      expect(getComputedStyle(other).outlineStyle).toBe("none");
    }
  });
});
