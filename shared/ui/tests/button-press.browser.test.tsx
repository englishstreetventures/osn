/**
 * `Button`'s press: while a pointer or a held Space presses it, it scales to
 * 0.97 on the press tokens (`--ui-dur-fast` on `--ui-ease-out`), and eases
 * back when let go. Never while it is disabled, busy or says it is unavailable
 * (`aria-disabled`), never under `prefers-reduced-motion: reduce`, and never at
 * `size="inline"`, a link inside a sentence.
 *
 * Real input throughout: `:active` holds only while the browser holds a real
 * mouse button or key down, so a dispatched event would test nothing. Every
 * computed value is read under the package's test stylesheet, a real Tailwind
 * build of `Button`'s own classes. Each case leaves a screenshot of the pressed
 * button in the gitignored `__screenshots__/` beside the file.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import { Button, buttonVariants, type ButtonProps } from "../src/ui/button";
import { emulateMedia, rootEasing, rootMs } from "./test-support/motion";

import "./test-support/tailwind.css";

type Variant = NonNullable<ButtonProps["variant"]>;

const press = commands as unknown as {
  pressPointer: (o: { selector: string }) => Promise<void>;
  releasePointer: () => Promise<void>;
  holdKey: (key: string) => Promise<void>;
  releaseKey: (key: string) => Promise<void>;
};

const VARIANTS = Object.keys({
  default: 1,
  destructive: 1,
  outline: 1,
  secondary: 1,
  ghost: 1,
  ghostDanger: 1,
  link: 1,
} satisfies Record<Variant, 1>) as Variant[];

/** The sizes that draw a box; `default` is covered by every variant. */
const BOX_SIZES = ["sm", "lg", "icon"] as const;

const PRESSED = "0.97";

const shot = (name: string) => `__screenshots__/button-press.browser.test.tsx/${name}.png`;

afterEach(async () => {
  await press.releasePointer();
  await press.releaseKey("Space");
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

/** The running transition on `scale`, if the press started one. */
function scaleTransition(element: Element): CSSTransition | undefined {
  return element
    .getAnimations()
    .find(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition && animation.transitionProperty === "scale",
    );
}

/** Wait out the press: the `scale` transition's end, or a frame when none runs. */
async function settled(element: Element) {
  const running = scaleTransition(element);
  if (running) await running.finished;
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

const scaleOf = (element: Element) => getComputedStyle(element).scale;

/** Render inside a frame with a test id, so the pointer and the shot can find it. */
function renderInFrame(children: () => import("solid-js").JSX.Element) {
  render(() => (
    <div data-testid="frame" style={{ padding: "16px", display: "inline-block" }}>
      {children()}
    </div>
  ));
  return screen.getByTestId("frame");
}

describe("Button pressed by a pointer", () => {
  it("scales to 0.97 on the press tokens, and back when let go", async () => {
    const frame = renderInFrame(() => <Button data-testid="target">Create</Button>);
    const target = screen.getByTestId("target");
    expect(scaleOf(target)).toBe("none");

    await press.pressPointer({ selector: '[data-testid="target"]' });
    expect(target.matches(":active")).toBe(true);
    const running = scaleTransition(target);
    expect(running, "a transition on scale").toBeDefined();
    const timing = running!.effect!.getTiming();
    expect(timing.duration).toBe(rootMs("--ui-dur-fast"));
    expect(timing.easing).toBe(rootEasing("--ui-ease-out"));

    await settled(target);
    expect(target.matches(":active")).toBe(true);
    expect(scaleOf(target)).toBe(PRESSED);
    await page.screenshot({ path: shot("press-default"), element: frame });

    await press.releasePointer();
    expect(target.matches(":active")).toBe(false);
    await settled(target);
    expect(scaleOf(target)).toBe("none");
  });

  it.each(VARIANTS)("presses at variant %s", async (variant) => {
    const frame = renderInFrame(() => (
      <Button data-testid="target" variant={variant}>
        Create
      </Button>
    ));
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    await settled(target);
    expect(scaleOf(target)).toBe(PRESSED);
    await page.screenshot({ path: shot(`press-${variant}`), element: frame });
  });

  it.each(BOX_SIZES)("presses at size %s", async (size) => {
    renderInFrame(() =>
      size === "icon" ? (
        <Button data-testid="target" size="icon" aria-label="Add" />
      ) : (
        <Button data-testid="target" size={size}>
          Create
        </Button>
      ),
    );
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    await settled(target);
    expect(scaleOf(target)).toBe(PRESSED);
  });

  it("presses a link wearing buttonVariants", async () => {
    renderInFrame(() => (
      <a
        data-testid="target"
        href="#settings"
        class={buttonVariants({ variant: "outline", size: "sm" })}
        onClick={(event) => event.preventDefault()}
      >
        Settings
      </a>
    ));
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    await settled(target);
    expect(target.matches(":active")).toBe(true);
    expect(scaleOf(target)).toBe(PRESSED);
  });

  it("keeps a call site's transform beside the press", async () => {
    renderInFrame(() => (
      <Button data-testid="target" style={{ transform: "translateX(4px)" }}>
        Create
      </Button>
    ));
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    await settled(target);
    expect(scaleOf(target)).toBe(PRESSED);
    expect(getComputedStyle(target).transform).toBe("matrix(1, 0, 0, 1, 4, 0)");
  });
});

describe("Button that does not press", () => {
  it("does not scale while disabled, even where the pointer reaches it", async () => {
    // `pointer-events-auto` beats the disabled button's `pointer-events-none`,
    // as a caller that wants a tooltip over a disabled button would write it,
    // so the press reaches the button and only the press rule's own guard
    // keeps it still.
    const frame = renderInFrame(() => (
      <Button data-testid="target" disabled style={{ "pointer-events": "auto" }}>
        Create
      </Button>
    ));
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    expect(target.matches(":active")).toBe(true);
    await settled(target);
    expect(scaleTransition(target)).toBeUndefined();
    expect(scaleOf(target)).toBe("none");
    await page.screenshot({ path: shot("press-disabled"), element: frame });
  });

  it("does not scale while it says it is unavailable (aria-disabled)", async () => {
    renderInFrame(() => (
      <Button data-testid="target" aria-disabled="true">
        Create
      </Button>
    ));
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    expect(target.matches(":active")).toBe(true);
    await settled(target);
    expect(scaleOf(target)).toBe("none");
  });

  it("does not scale a link inside a sentence", async () => {
    renderInFrame(() => (
      <p>
        Accept the{" "}
        <Button data-testid="target" variant="link" size="inline">
          terms
        </Button>
        .
      </p>
    ));
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    expect(target.matches(":active")).toBe(true);
    await settled(target);
    expect(scaleOf(target)).toBe("none");
  });

  it("does not scale under reduced motion", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    renderInFrame(() => <Button data-testid="target">Create</Button>);
    const target = screen.getByTestId("target");
    await press.pressPointer({ selector: '[data-testid="target"]' });
    expect(target.matches(":active")).toBe(true);
    await settled(target);
    expect(scaleTransition(target)).toBeUndefined();
    expect(scaleOf(target)).toBe("none");
  });
});

describe("Button pressed with Space held", () => {
  /** Tab onto the button from the one before it, then hold Space. */
  async function holdSpaceOn(target: HTMLElement) {
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(target);
    await press.holdKey("Space");
  }

  it("scales an idle button, as a pointer press does", async () => {
    renderInFrame(() => (
      <>
        <button type="button">Before</button>
        <Button data-testid="target">Create</Button>
      </>
    ));
    const target = screen.getByTestId("target");
    await holdSpaceOn(target);
    expect(target.matches(":active")).toBe(true);
    await settled(target);
    expect(scaleOf(target)).toBe(PRESSED);
  });

  it("does not scale a busy button, which keeps keyboard focus", async () => {
    const frame = renderInFrame(() => (
      <>
        <button type="button">Before</button>
        <Button data-testid="target" busy>
          Creating…
        </Button>
      </>
    ));
    const target = screen.getByTestId("target");
    await holdSpaceOn(target);
    expect(target.matches(":active")).toBe(true);
    await settled(target);
    expect(scaleTransition(target)).toBeUndefined();
    expect(scaleOf(target)).toBe("none");
    await page.screenshot({ path: shot("press-busy"), element: frame });
  });
});
