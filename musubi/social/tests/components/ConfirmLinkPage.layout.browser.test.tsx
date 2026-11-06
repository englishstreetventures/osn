/**
 * `ConfirmLinkPage` laid out where people see it: on a bare route, inside the
 * `<main>` the host draws around it, under musubi's own stylesheet, in a real
 * Chromium.
 *
 * `@osn/auth-ui` has no browser tier, and musubi is the one app that renders
 * the page, so the layout claims its wiki section makes are held here:
 *
 * - a long address breaks inside a 320px phone's column, so neither the card
 *   nor the page scrolls sideways (`wrap-anywhere` on the address);
 * - the one button is 44px tall below `md` (`max-md:h-11`) and `Button`'s own
 *   `lg` 40px from `md` up, in every state that draws one;
 * - the error notice sits directly above Try again.
 *
 * The page sits where the host route will put it: `AuthorizePage`'s `<main>`
 * (`mx-auto … max-w-md px-6 py-10`), with no app shell. At a 320px viewport
 * that leaves the card 272px.
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
 * confirm call does when the test presses the button.
 */
async function mountOnRoute(answer: "confirmed" | "throws", onContinue?: () => void) {
  render(() => (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-10">
      <ConfirmLinkPage
        purpose="sign-up"
        email={LONG_EMAIL}
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
  // The card is the element the page draws outermost: the `Card` around it all.
  const card = heading.closest("main")?.firstElementChild as HTMLElement;
  return { card };
}

/** Presses the page's one button and waits for the answer to be drawn. */
async function press(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await painted();
}

function buttonHeight(name: string) {
  return screen.getByRole("button", { name }).getBoundingClientRect().height;
}

describe("ConfirmLinkPage on a bare musubi route", () => {
  it("breaks a long address inside a 320px phone's column, so nothing scrolls sideways", async () => {
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

    await page.screenshot({ path: `${SHOTS}/ready-320.png` });
  });

  it("draws the button 44px tall below md, ready, after an error and once confirmed", async () => {
    await atViewport(PHONE);
    await mountOnRoute("throws");
    expect(buttonHeight("Confirm")).toBe(44);

    await press("Confirm");
    expect(buttonHeight("Try again")).toBe(44);
    await page.screenshot({ path: `${SHOTS}/error-320.png` });

    cleanup();
    await mountOnRoute("confirmed", () => {});
    await press("Confirm");
    expect(buttonHeight("Continue")).toBe(44);
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);
    await page.screenshot({ path: `${SHOTS}/confirmed-continue-320.png` });
  });

  it("draws the button at Button's own 40px from md up", async () => {
    await atViewport(DESKTOP);
    await mountOnRoute("throws");
    expect(buttonHeight("Confirm")).toBe(40);

    await press("Confirm");
    expect(buttonHeight("Try again")).toBe(40);

    await page.screenshot({ path: `${SHOTS}/error-1280.png` });
  });

  it("puts the error notice directly above Try again", async () => {
    await atViewport(PHONE);
    await mountOnRoute("throws");
    await press("Confirm");

    // The heading's block holds the heading, the sentences and the notice,
    // which is the one `<div>` among them.
    const block = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
    const notice = [...block.children].find((el) => el.tagName === "DIV") as HTMLElement;
    expect(notice.textContent).toContain("We couldn't confirm this email just now.");
    const button = screen.getByRole("button", { name: "Try again" });
    const lines = [...block.querySelectorAll(":scope > p")];
    expect(lines).toHaveLength(2);

    // Every sentence ends above the notice, and the button starts below it.
    for (const line of lines) {
      expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        notice.getBoundingClientRect().top,
      );
    }
    expect(notice.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      button.getBoundingClientRect().top,
    );
  });
});
