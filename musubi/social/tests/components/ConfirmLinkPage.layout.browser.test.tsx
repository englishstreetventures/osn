/**
 * `ConfirmLinkPage` laid out where people see it: on a bare route, inside the
 * `<main>` the host draws around it, under musubi's own stylesheet, in a real
 * Chromium.
 *
 * `@osn/auth-ui` has no browser tier, and musubi is the one app that renders
 * the page, so the layout claims its wiki section makes are held here:
 *
 * - five six-digit numbers, the most and the longest the page offers, and a
 *   long address fit a 320px phone's column, so neither the card nor the page
 *   scrolls sideways (`wrap-anywhere` on the address, one column of numbers);
 * - each number is a target at least 44px tall, its digits 24px in tabular
 *   figures, as the waiting screen draws the number;
 * - "I didn't ask for this" sits under the numbers, inside the card, 44px
 *   tall below `md` (`max-md:h-11`) and `Button`'s own `sm` 32px from it;
 * - Try again and Continue are 44px tall below `md` (`max-md:h-11`) and
 *   `Button`'s own `lg` 40px from `md` up;
 * - the error notice sits directly above Try again;
 * - typed, the field, Confirm and the decline fit the same column, each at
 *   least 44px tall below `md`, with 16px type so a phone does not zoom.
 *
 * The page sits in a bare route's `<main>` (`mx-auto … max-w-md px-6 py-10`),
 * with no app shell. At a 320px viewport that leaves the card 272px. The host
 * page itself, with its name above the card, its own failed card and its
 * placeholder, is held by `tests/pages/VerifyEmailLinkPage.layout.browser.test.tsx`.
 *
 * Each case writes a screenshot to `__screenshots__/` beside this file
 * (gitignored).
 */

import { ConfirmLinkPage, type ConfirmOutcome } from "@osn/auth-ui/ConfirmLinkPage";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

const LONG_EMAIL = "alexandria.whitfield-oduya.newsletters@mail.subdomain.example.com";

const FIVE_WIDEST = ["804117", "390265", "117943", "652080", "029318"];

const PHONE = { width: 320, height: 640 };
const DESKTOP = { width: 1280, height: 800 };

const SHOTS = "__screenshots__/ConfirmLinkPage.layout.browser.test.tsx";

afterEach(() => {
  cleanup();
});

/** Resize, and wait until the frame has the new size before anything mounts. */
async function atViewport({ width, height }: { width: number; height: number }) {
  const resized =
    innerWidth === width && innerHeight === height
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          window.addEventListener("resize", () => resolve(), { once: true }),
        );
  await page.viewport(width, height);
  await resized;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Two frames and loaded faces: a box read against fallback metrics is a different number. */
async function painted() {
  await nextFrame();
  await nextFrame();
  await document.fonts.ready;
}

/**
 * The page on its bare route, as the host draws it. `answer` is what the
 * confirm call does when the test taps a number.
 */
async function mountOnRoute(answer: "confirmed" | "throws", onContinue?: () => void) {
  render(() => (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-10">
      <ConfirmLinkPage
        purpose="sign-up"
        email={LONG_EMAIL}
        candidates={FIVE_WIDEST}
        onConfirm={() =>
          answer === "throws"
            ? Promise.reject(new Error("no connection"))
            : Promise.resolve<ConfirmOutcome>("confirmed")
        }
        onContinue={onContinue}
      />
    </main>
  ));
  await painted();
  const heading = screen.getByRole("heading", { level: 1 });
  // The card is the child of `<main>` that holds the heading: the `Card`
  // around it all, never a sibling the host draws above it.
  const card = heading.closest("main > *") as HTMLElement;
  return { card };
}

/** Taps a button and waits for the answer to be drawn. */
async function press(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await painted();
}

function buttonHeight(name: string) {
  return screen.getByRole("button", { name }).getBoundingClientRect().height;
}

function numbers() {
  return [...screen.getByRole("group").querySelectorAll("button")];
}

describe("ConfirmLinkPage on a bare musubi route", () => {
  it("fits five six-digit numbers and a long address in a 320px phone's column, so nothing scrolls sideways", async () => {
    await atViewport(PHONE);
    const { card } = await mountOnRoute("confirmed");

    // The setup this claim is about: the card is 272px.
    expect(card.getBoundingClientRect().width).toBe(272);

    expect(card.scrollWidth).toBe(card.clientWidth);
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);

    const address = screen.getByText(LONG_EMAIL);
    const sentence = address.closest("p") as HTMLElement;
    expect(address.getBoundingClientRect().right).toBeLessThanOrEqual(
      sentence.getBoundingClientRect().right,
    );

    const cardBox = card.getBoundingClientRect();
    const buttons = numbers();
    expect(buttons.map((b) => b.textContent)).toEqual(FIVE_WIDEST);
    for (const button of buttons) {
      const box = button.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(cardBox.left);
      expect(box.right).toBeLessThanOrEqual(cardBox.right);
      // One column: each number is as wide as the one above it, and below it.
      expect(box.width).toBe(buttons[0]?.getBoundingClientRect().width);
    }
    for (let i = 1; i < buttons.length; i++) {
      const above = buttons[i - 1]?.getBoundingClientRect();
      expect(buttons[i]?.getBoundingClientRect().top).toBeGreaterThan(above?.bottom ?? 0);
    }

    const decline = screen.getByRole("button", { name: "I didn't ask for this" });
    const declineBox = decline.getBoundingClientRect();
    expect(declineBox.top).toBeGreaterThan(buttons.at(-1)?.getBoundingClientRect().bottom ?? 0);
    expect(declineBox.left).toBeGreaterThanOrEqual(cardBox.left);
    expect(declineBox.right).toBeLessThanOrEqual(cardBox.right);
    expect(declineBox.bottom).toBeLessThanOrEqual(cardBox.bottom);

    await page.screenshot({ path: `${SHOTS}/five-numbers-320.png` });
  });

  it("makes each number a target at least 44px tall, one under another as wide as the card allows, with its digits 24px in tabular figures", async () => {
    for (const viewport of [PHONE, DESKTOP]) {
      await atViewport(viewport);
      await mountOnRoute("confirmed");
      const group = screen.getByRole("group").getBoundingClientRect();
      const boxes = numbers().map((button) => button.getBoundingClientRect());
      for (const box of boxes) expect(box.width).toBe(group.width);
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i]?.top).toBeGreaterThan(boxes[i - 1]?.bottom ?? 0);
      }
      for (const button of numbers()) {
        expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        const digits = button.querySelector("[translate='no']") as HTMLElement;
        const style = getComputedStyle(digits);
        expect(style.fontSize).toBe("24px");
        expect(style.fontVariantNumeric).toBe("tabular-nums");
        expect(digits.getBoundingClientRect().right).toBeLessThanOrEqual(
          button.getBoundingClientRect().right,
        );
      }
      cleanup();
    }
  });

  it("draws I didn't ask for this 44px tall below md and 32px from it", async () => {
    await atViewport(PHONE);
    await mountOnRoute("confirmed");
    expect(buttonHeight("I didn't ask for this")).toBe(44);
    cleanup();

    await atViewport(DESKTOP);
    await mountOnRoute("confirmed");
    expect(buttonHeight("I didn't ask for this")).toBe(32);
  });

  it("draws Try again and Continue 44px tall below md", async () => {
    await atViewport(PHONE);
    await mountOnRoute("throws");
    await press(FIVE_WIDEST[2] as string);
    expect(buttonHeight("Try again")).toBe(44);
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);
    await page.screenshot({ path: `${SHOTS}/error-320.png` });

    cleanup();
    await mountOnRoute("confirmed", () => {});
    await press(FIVE_WIDEST[0] as string);
    expect(buttonHeight("Continue")).toBe(44);
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);
    await page.screenshot({ path: `${SHOTS}/confirmed-continue-320.png` });
  });

  it("draws Try again at Button's own 40px from md up", async () => {
    await atViewport(DESKTOP);
    await mountOnRoute("throws");
    await page.screenshot({ path: `${SHOTS}/ready-1280.png` });

    await press(FIVE_WIDEST[2] as string);
    expect(buttonHeight("Try again")).toBe(40);

    await page.screenshot({ path: `${SHOTS}/error-1280.png` });
  });

  it("puts the error notice directly above Try again", async () => {
    await atViewport(PHONE);
    await mountOnRoute("throws");
    await press(FIVE_WIDEST[2] as string);

    // The line sits in the notice's own text box; the notice is its parent,
    // mark and all. The spoken `<output>` repeats the line and is skipped.
    const notice = screen.getByText("We couldn't confirm this email just now.", {
      ignore: "output",
    }).parentElement as HTMLElement;
    const button = screen.getByRole("button", { name: "Try again" });
    const group = screen.getByRole("group");
    const picked = screen.getByText(
      (_, el) => el?.tagName === "P" && el.textContent === `You picked ${FIVE_WIDEST[2]}.`,
    );

    // The numbers, then the number picked, then the notice, then the button.
    expect(group.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      picked.getBoundingClientRect().top,
    );
    expect(picked.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      notice.getBoundingClientRect().top,
    );
    expect(notice.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      button.getBoundingClientRect().top,
    );
  });
});

/** A colour painted over `under` on a one-pixel canvas, as the browser composites it. */
function painted1px(under: string, colour: string): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.fillStyle = under;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = colour;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** WCAG's contrast ratio between two sRGB colours. */
function contrast(a: [number, number, number], b: [number, number, number]) {
  const lum = (rgb: [number, number, number]) => {
    const [r, g, b2] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

/** The page in typed mode, as recovery's host draws it. */
async function mountTyped(answer: "confirmed" | "throws") {
  render(() => (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-10">
      <ConfirmLinkPage
        purpose="recovery"
        email={LONG_EMAIL}
        typeNumber
        onConfirm={() =>
          answer === "throws"
            ? Promise.reject(new Error("no connection"))
            : Promise.resolve<ConfirmOutcome>("confirmed")
        }
      />
    </main>
  ));
  await painted();
  const heading = screen.getByRole("heading", { level: 1 });
  const card = heading.closest("main > *") as HTMLElement;
  const field = screen.getByLabelText(
    "Type the number shown on the screen where you started.",
  ) as HTMLInputElement;
  return { card, field };
}

describe("ConfirmLinkPage typing the number, on a bare musubi route", () => {
  it("fits the field and its buttons in a 320px phone's column, every target at least 44px", async () => {
    await atViewport(PHONE);
    const { card, field } = await mountTyped("throws");
    fireEvent.input(field, { target: { value: "123456" } });
    await painted();

    expect(card.getBoundingClientRect().width).toBe(272);
    expect(card.scrollWidth).toBe(card.clientWidth);
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);

    const cardBox = card.getBoundingClientRect();
    const targets = [
      field,
      screen.getByRole("button", { name: "Confirm" }),
      screen.getByRole("button", { name: "I didn't ask for this" }),
    ];
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.left).toBeGreaterThanOrEqual(cardBox.left);
      expect(box.right).toBeLessThanOrEqual(cardBox.right);
    }
    // A six-digit entry sits inside the field, with nothing to scroll.
    expect(field.scrollWidth).toBe(field.clientWidth);
    // 16px type below 640px, so a phone's browser does not zoom on focus.
    expect(getComputedStyle(field).fontSize).toBe("16px");
    // A plain label, as every auth form field has: the control step at 500 in
    // the heading's full ink, 6px above the field.
    const label = document.querySelector<HTMLElement>(`label[for="${field.id}"]`);
    if (!label) throw new Error("the field has no label");
    const labelStyle = getComputedStyle(label);
    expect(labelStyle.fontSize).toBe("14px");
    expect(labelStyle.fontWeight).toBe("500");
    expect(labelStyle.color).toBe(
      getComputedStyle(screen.getByRole("heading", { level: 1 })).color,
    );
    expect(field.getBoundingClientRect().top - label.getBoundingClientRect().bottom).toBe(6);
    // The field's edge, on the card it sits on, clears the 3:1 a control needs.
    const cardFill = getComputedStyle(card).backgroundColor;
    expect(
      contrast(
        painted1px(cardFill, getComputedStyle(field).borderTopColor),
        painted1px(cardFill, cardFill),
      ),
    ).toBeGreaterThanOrEqual(3);

    await page.screenshot({ path: `${SHOTS}/typed-320.png` });

    await press("Confirm");
    expect(buttonHeight("Try again")).toBe(44);
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);
    await page.screenshot({ path: `${SHOTS}/typed-error-320.png` });
  });

  it("draws Confirm at Button's own 40px from md up", async () => {
    await atViewport(DESKTOP);
    const { field } = await mountTyped("confirmed");
    fireEvent.input(field, { target: { value: "4821" } });
    await painted();

    expect(buttonHeight("Confirm")).toBe(40);
    await page.screenshot({ path: `${SHOTS}/typed-1280.png` });
  });
});
