/**
 * `Button` with `busy`: a wait shown inside the button that started it.
 *
 * While busy the button keeps keyboard focus, says so to assistive technology
 * (`aria-busy`, `aria-disabled`), refuses activation from every route a
 * pointer, a key or a form's implicit submission can take, dims as a disabled
 * button does, and draws the 20px orb before its label. Not busy, it is the
 * Button it always was.
 *
 * Each file runs in a frame of its own, so this one's orb loads once and stays
 * loaded: the first-load cases, and a failed load, are in
 * `button-busy-load`, `button-busy-preload` and `button-busy-failed`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import { Button, buttonVariants } from "../src/ui/button";

import "./test-support/tailwind.css";

const emulateMedia = (options: { forcedColors: "active" | "none" }) =>
  (
    commands as unknown as {
      emulateMedia: (o: { forcedColors: "active" | "none" }) => Promise<void>;
    }
  ).emulateMedia(options);

beforeAll(async () => {
  await emulateMedia({ forcedColors: "none" });
});

afterEach(() => {
  cleanup();
});

const shot = (name: string) => `__screenshots__/button-busy.browser.test.tsx/${name}.png`;

/** Wait for the orb's canvas inside `button`, which arrives once its module has. */
async function orbIn(button: HTMLElement) {
  await expect.poll(() => button.querySelector("canvas"), { timeout: 5000 }).not.toBeNull();
  return button.querySelector("canvas")!;
}

/** Jump every running transition to its end, so no value is read part-way. */
function settle() {
  for (const animation of document.getAnimations()) animation.finish();
}

// Never called: the type checker reads these, and each line it accepts fails
// `bun run --cwd shared/ui typecheck`.
function typeChecks() {
  return (
    <>
      <Button busy>Creating…</Button>
      <Button size="sm" busy={false}>
        Save
      </Button>
      {/* @ts-expect-error an icon button has no label for the orb to sit beside. */}
      <Button size="icon" busy aria-label="Refresh" />
      {/* @ts-expect-error an inline link has no room for the orb. */}
      <Button variant="link" size="inline" busy>
        terms
      </Button>
    </>
  );
}
void typeChecks;

describe("a Button that is not busy", () => {
  it("renders the element it rendered before: one class, no mark", () => {
    render(() => (
      <div>
        <Button>Save</Button>
        <Button busy={false}>Send</Button>
      </div>
    ));
    for (const name of ["Save", "Send"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttributeNames()).toEqual(["class"]);
      expect(button.getAttribute("class")).toBe(buttonVariants());
      expect(button.children).toHaveLength(0);
      expect(button.textContent).toBe(name);
    }
  });

  it("calls a function onClick with the event, and a tuple onClick with its data first", async () => {
    const fn = vi.fn();
    const bound = vi.fn();
    render(() => (
      <div>
        <Button onClick={fn}>Plain</Button>
        <Button onClick={[bound, "row-7"]}>Bound</Button>
      </div>
    ));
    await userEvent.click(screen.getByRole("button", { name: "Plain" }));
    await userEvent.click(screen.getByRole("button", { name: "Bound" }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toBeInstanceOf(MouseEvent);
    expect(bound).toHaveBeenCalledTimes(1);
    expect(bound.mock.calls[0]![0]).toBe("row-7");
    expect(bound.mock.calls[0]![1]).toBeInstanceOf(MouseEvent);
  });
});

describe("a busy Button", () => {
  it("says busy and unavailable while busy, and stops saying it after", () => {
    const [busy, setBusy] = createSignal(true);
    render(() => (
      <div>
        <Button busy={busy()}>Save</Button>
        <Button busy={busy()} aria-disabled="true">
          Locked
        </Button>
      </div>
    ));
    const save = screen.getByRole("button", { name: "Save" });
    const locked = screen.getByRole("button", { name: "Locked" });
    for (const button of [save, locked]) {
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
    }
    setBusy(false);
    expect(save.hasAttribute("aria-busy")).toBe(false);
    expect(save.hasAttribute("aria-disabled")).toBe(false);
    expect(locked.hasAttribute("aria-busy")).toBe(false);
    expect(locked.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps keyboard focus when it turns busy", async () => {
    const [busy, setBusy] = createSignal(false);
    render(() => (
      <div>
        <button type="button">Before</button>
        <Button busy={busy()}>Save</Button>
      </div>
    ));
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    const button = screen.getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(button);
    setBusy(true);
    await orbIn(button);
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(true);
  });

  it("calls no onClick from a pointer press, Enter or Space, and calls it again once done", async () => {
    const onClick = vi.fn();
    const [busy, setBusy] = createSignal(true);
    render(() => (
      <div data-testid="frame" style={{ padding: "8px" }}>
        <Button busy={busy()} onClick={onClick}>
          Save
        </Button>
      </div>
    ));
    const button = screen.getByRole("button", { name: "Save" });
    const box = button.getBoundingClientRect();
    // The pointer passes through to what is behind, as on a disabled button.
    expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).not.toBe(
      button,
    );
    await userEvent.click(button, { force: true });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).not.toHaveBeenCalled();

    setBusy(false);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not submit its form from a pointer press, Enter, Space or Enter in a field", async () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const [busy, setBusy] = createSignal(true);
    render(() => (
      <form onSubmit={onSubmit}>
        <input aria-label="Name" />
        <Button type="submit" busy={busy()}>
          Create
        </Button>
      </form>
    ));
    const button = screen.getByRole("button", { name: "Create" });
    const field = screen.getByRole("textbox", { name: "Name" });

    await userEvent.click(button, { force: true });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    field.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    setBusy(false);
    field.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("dims as a disabled button does", async () => {
    render(() => (
      <div>
        <div data-testid="away" style={{ width: "40px", height: "40px" }} />
        <Button busy>Busy</Button>
        <Button disabled>Disabled</Button>
      </div>
    ));
    await userEvent.hover(screen.getByTestId("away"));
    settle();
    const read = (name: string) => {
      const style = getComputedStyle(screen.getByRole("button", { name }));
      return [style.opacity, style.pointerEvents];
    };
    expect(read("Busy")).toEqual(read("Disabled"));
    expect(read("Busy")).toEqual(["0.5", "none"]);
  });

  it("draws a 20px orb before its label, hidden from assistive technology", async () => {
    render(() => <Button busy>Creating…</Button>);
    const button = screen.getByRole("button", { name: "Creating…" });
    const canvas = await orbIn(button);
    expect(button.firstChild).toBe(canvas);
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    const box = canvas.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([20, 20]);
    const label = [...button.childNodes].find((node) => node.textContent === "Creating…");
    expect(label).toBeDefined();
    expect(canvas.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const node = (await accessibilityTree()).find((n) => !n.ignored && n.role?.value === "button");
    expect(node?.name?.value).toBe("Creating…");
    const property = (name: string) => node?.properties?.find((p) => p.name === name)?.value.value;
    // Chrome types `busy` as a boolean and reports it as `1`.
    expect(property("busy")).toBe(1);
    expect(property("disabled")).toBe(true);
  });

  it("draws every text variant and size busy", async () => {
    const variants = [
      "default",
      "destructive",
      "outline",
      "secondary",
      "ghost",
      "ghostDanger",
      "link",
    ] as const;
    render(() => (
      <div
        data-testid="frame"
        style={{ padding: "12px", display: "flex", gap: "8px", "flex-direction": "column" }}
      >
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          {variants.map((variant) => (
            <Button variant={variant} busy>
              {variant}
            </Button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <Button size="sm" busy>
            Small
          </Button>
          <Button busy>Default</Button>
          <Button size="lg" busy>
            Large
          </Button>
        </div>
      </div>
    ));
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) await orbIn(button);
    expect(buttons.filter((button) => button.firstChild instanceof HTMLCanvasElement)).toHaveLength(
      variants.length + 3,
    );
    await page.screenshot({ path: shot("variants"), element: screen.getByTestId("frame") });
  });
});

interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
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
  return nodes;
}
