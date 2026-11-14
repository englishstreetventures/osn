/**
 * `CheckEmailView` laid out where people see it: inside musubi's auth sheet,
 * under musubi's own stylesheet, in a real Chromium.
 *
 * `@osn/auth-ui` has no browser tier, and musubi is the one app that renders
 * the view, so the three layout claims its wiki section makes are held here:
 *
 * - a long address breaks inside a 320px phone's column, so nothing scrolls
 *   sideways (`wrap-anywhere` on the address);
 * - "Resend in 30s" is one run of text on one line, because the label is a
 *   single span and `Button` is a gapped flex row that would set each child of
 *   its own apart;
 * - both buttons are 40px tall below `md`, musubi's phone touch height, and
 *   `Button`'s own 32px from `md` up.
 *
 * The view sits where `Register` puts it in musubi's create-account dialog:
 * `ResponsiveDialogContent` (a bottom sheet below `md`, full width with no
 * side border or padding), then `Register`'s root (`flex flex-col`) and the
 * body `ViewStep` draws for `host="dialog"`, padded 16px (`ViewParts.tsx`).
 * At a 320px viewport that leaves the view a 288px column.
 *
 * Each case writes a screenshot to `__screenshots__/` beside this file
 * (gitignored).
 */

import { CheckEmailView } from "@osn/auth-ui/CheckEmailView";
import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";
import { ResponsiveDialogContent } from "../../src/components/ResponsiveDialogContent";

const LONG_EMAIL = "alexandria.whitfield-oduya.newsletters@mail.subdomain.example.com";

const PHONE = { width: 320, height: 640 };
const DESKTOP = { width: 1280, height: 800 };

const SHOTS = "__screenshots__/CheckEmailView.layout.browser.test.tsx";

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

/**
 * The view in an open sheet, with "Start again" drawn, once the
 * sheet's entry has finished and the faces have loaded, so no box is read
 * mid-animation or against fallback metrics.
 */
async function mountInSheet(email: string, pairingCode?: string) {
  render(() => (
    <Dialog open onOpenChange={() => {}}>
      <ResponsiveDialogContent aria-label="Check your email">
        <div class="flex flex-col">
          <div class="flex flex-col gap-4 p-4">
            <CheckEmailView
              email={email}
              purpose="sign-up"
              status="waiting"
              pairingCode={pairingCode}
              onResend={() => {}}
              onChangeEmail={() => {}}
            />
          </div>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  ));
  await nextFrame();
  await nextFrame();
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  await document.fonts.ready;

  const sheet = screen.getByRole("dialog");
  const view = screen.getByRole("heading", { level: 3 }).parentElement as HTMLElement;
  const resend = screen.getByRole("button", { name: /^Resend in/ });
  const changeEmail = screen.getByRole("button", { name: "Start again" });
  return { sheet, view, resend, changeEmail };
}

describe("CheckEmailView in musubi's auth sheet", () => {
  it("breaks a long address inside a 320px phone's column, so nothing scrolls sideways", async () => {
    await atViewport(PHONE);
    const { sheet, view } = await mountInSheet(LONG_EMAIL);

    // The setup this claim is about: the view's column is 288px.
    expect(view.clientWidth).toBe(288);

    expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);
    expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE.width);

    const address = screen.getByText(LONG_EMAIL);
    const sentence = address.closest("p") as HTMLElement;
    expect(address.getBoundingClientRect().right).toBeLessThanOrEqual(
      sentence.getBoundingClientRect().right,
    );

    await page.screenshot({ path: `${SHOTS}/long-address-320.png` });
  });

  it("draws the countdown as one run of text on one line at 320px", async () => {
    await atViewport(PHONE);
    const { resend } = await mountInSheet(LONG_EMAIL);

    // The label is the button's one child, a span holding all of it.
    const label = resend.firstElementChild as HTMLElement;
    expect(label.textContent).toBe("Resend in 30s");
    expect(label.getClientRects()).toHaveLength(1);

    // Each piece of text starts where the one before it ends: no flex gap
    // between "Resend in ", "30" and "s".
    const walker = document.createTreeWalker(resend, NodeFilter.SHOW_TEXT);
    const pieces: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      pieces.push(range.getBoundingClientRect());
    }
    expect(pieces).toHaveLength(3);
    for (let i = 1; i < pieces.length; i++) {
      const before = pieces[i - 1] as DOMRect;
      const piece = pieces[i] as DOMRect;
      expect(Math.abs(piece.left - before.right)).toBeLessThanOrEqual(0.5);
      expect(piece.top).toBe(before.top);
    }

    await page.screenshot({ path: `${SHOTS}/countdown-320.png` });
  });

  it("draws the widest number inside a 320px phone's column, at 24px in tabular figures, its label hidden", async () => {
    await atViewport(PHONE);
    const { sheet, view } = await mountInSheet(LONG_EMAIL, "123456");

    expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);
    expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE.width);

    const digits = view.querySelector('span[translate="no"]') as HTMLElement;
    expect(digits.textContent).toBe("123456");
    const number = digits.parentElement as HTMLElement;

    // The digits' own box, not the paragraph's, which spans the column whatever
    // the digits do.
    const range = document.createRange();
    range.selectNodeContents(digits);
    expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(
      view.getBoundingClientRect().right,
    );

    const style = getComputedStyle(number);
    expect(style.fontVariantNumeric).toContain("tabular-nums");
    expect(style.fontSize).toBe("24px");
    expect(style.lineHeight).toBe("30px");
    expect(style.fontWeight).toBe("500");

    // "Your number:" is drawn nowhere on screen, but is read before the digits.
    const label = number.firstElementChild as HTMLElement;
    expect(label.textContent).toBe("Your number:");
    const box = label.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([1, 1]);
    await expect
      .element(page.elementLocator(number))
      .toMatchAriaInlineSnapshot(`- paragraph: "Your number: 123456"`);

    await page.screenshot({ path: `${SHOTS}/pairing-code-320.png` });
  });

  it("draws both buttons 40px tall below md", async () => {
    await atViewport(PHONE);
    const { resend, changeEmail } = await mountInSheet(LONG_EMAIL);

    expect(resend.getBoundingClientRect().height).toBe(40);
    expect(changeEmail.getBoundingClientRect().height).toBe(40);
  });

  it("draws both buttons at Button's own 32px from md up", async () => {
    await atViewport(DESKTOP);
    const { resend, changeEmail } = await mountInSheet(LONG_EMAIL);

    expect(resend.getBoundingClientRect().height).toBe(32);
    expect(changeEmail.getBoundingClientRect().height).toBe(32);

    await page.screenshot({ path: `${SHOTS}/desktop-1280.png` });
  });
});
