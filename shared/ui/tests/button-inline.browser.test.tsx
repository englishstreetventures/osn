/**
 * `Button` at `size="inline"`: a link set inside a sentence.
 *
 * A standalone link underlines on hover; a link inside a sentence underlines
 * at rest, since its colour alone would not tell it from the words around it
 * (WCAG 1.4.1). It takes the sentence's type rather than Button's, adds no
 * height to the line, and an `<a>` wearing the classes wraps with the text.
 * Measured in real Chrome, since each of these is a computed style or a
 * layout that a DOM shim does not have.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import { Button, buttonVariants } from "../src/ui/button";

import "./test-support/tailwind.css";

const INLINE = buttonVariants({ variant: "link", size: "inline" });

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

const shot = (name: string) => `__screenshots__/button-inline.browser.test.tsx/${name}.png`;

/** Move the pointer off everything the test draws. */
async function hoverAway() {
  await userEvent.hover(screen.getByTestId("away"));
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
      <Button variant="link" size="inline">
        terms
      </Button>
      {/* @ts-expect-error `inline` is a size for `variant="link"` only. */}
      <Button size="inline">terms</Button>
      {/* @ts-expect-error `inline` is a size for `variant="link"` only. */}
      <Button variant="ghost" size="inline">
        terms
      </Button>
    </>
  );
}
void typeChecks;

describe("an inline link", () => {
  it("is underlined at rest, as a Button and on an <a>; a standalone link is not", async () => {
    render(() => (
      <div>
        <div data-testid="away" style={{ width: "40px", height: "40px" }} />
        <p>
          Read the{" "}
          <Button variant="link" size="inline">
            terms
          </Button>{" "}
          and the{" "}
          <a href="#policy" class={INLINE}>
            policy
          </a>
          .
        </p>
        <Button variant="link">Standalone</Button>
      </div>
    ));
    await hoverAway();
    settle();
    const button = screen.getByRole("button", { name: "terms" });
    const link = screen.getByRole("link", { name: "policy" });
    const standalone = screen.getByRole("button", { name: "Standalone" });
    for (const element of [button, link]) {
      expect(element.matches(":hover")).toBe(false);
      const style = getComputedStyle(element);
      expect(style.textDecorationLine).toBe("underline");
      expect(style.textUnderlineOffset).toBe("2px");
    }
    expect(getComputedStyle(standalone).textDecorationLine).toBe("none");
  });

  it.each([
    { fontSize: "18px", lineHeight: "28px", fontWeight: "400" },
    { fontSize: "13px", lineHeight: "20px", fontWeight: "600" },
  ])("takes the sentence's type at $fontSize, weight $fontWeight", (type) => {
    render(() => (
      <p
        data-testid="sentence"
        style={{
          "font-size": type.fontSize,
          "line-height": type.lineHeight,
          "font-weight": type.fontWeight,
        }}
      >
        Read the{" "}
        <Button variant="link" size="inline">
          terms
        </Button>{" "}
        and the{" "}
        <a href="#policy" class={INLINE}>
          policy
        </a>
        .
      </p>
    ));
    for (const element of [
      screen.getByRole("button", { name: "terms" }),
      screen.getByRole("link", { name: "policy" }),
    ]) {
      const style = getComputedStyle(element);
      expect([style.fontSize, style.lineHeight, style.fontWeight]).toEqual([
        type.fontSize,
        type.lineHeight,
        type.fontWeight,
      ]);
    }
  });

  it("adds no height to the line", () => {
    render(() => (
      <div style={{ width: "400px", "font-size": "14px", "line-height": "20px" }}>
        <p data-testid="with-link">
          Read the{" "}
          <Button variant="link" size="inline">
            terms
          </Button>{" "}
          first.
        </p>
        <p data-testid="plain">
          Read the <span>terms</span> first.
        </p>
      </div>
    ));
    expect(screen.getByTestId("with-link").getBoundingClientRect().height).toBe(
      screen.getByTestId("plain").getBoundingClientRect().height,
    );
  });

  it("wraps with the sentence when it is an <a>", () => {
    render(() => (
      <p style={{ width: "120px" }}>
        See{" "}
        <a href="#recovery" class={INLINE}>
          how to recover an account you can no longer reach
        </a>
        .
      </p>
    ));
    const link = screen.getByRole("link");
    expect(link.getClientRects().length).toBeGreaterThan(1);
  });

  it("draws the focus ring when reached from the keyboard", async () => {
    render(() => (
      <div data-testid="frame" style={{ padding: "12px", width: "180px" }}>
        <button type="button">Before</button>
        <p>
          Read the{" "}
          <Button variant="link" size="inline">
            terms
          </Button>{" "}
          and the{" "}
          <a href="#recovery" class={INLINE}>
            recovery steps for an account
          </a>
          .
        </p>
      </div>
    ));
    const button = screen.getByRole("button", { name: "terms" });
    const link = screen.getByRole("link");
    await page.screenshot({ path: shot("rest"), element: screen.getByTestId("frame") });

    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    settle();
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(button).boxShadow).not.toBe("none");
    await page.screenshot({ path: shot("focus-button"), element: screen.getByTestId("frame") });

    await userEvent.keyboard("{Tab}");
    settle();
    expect(document.activeElement).toBe(link);
    expect(link.matches(":focus-visible")).toBe(true);
    expect(link.getClientRects().length).toBeGreaterThan(1);
    expect(getComputedStyle(link).boxShadow).not.toBe("none");
    await page.screenshot({
      path: shot("focus-wrapped-link"),
      element: screen.getByTestId("frame"),
    });
  });
});
