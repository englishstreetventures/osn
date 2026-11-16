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
 *   `Button`'s own 32px from `md` up;
 * - the junk-mail line that arrives as Resend unlocks never puts "Start again"
 *   under a tap aimed at Resend: in the sheet, in the centred dialog, and in a
 *   frame that grows downward, as `/authorize`'s does;
 * - the wait's fill behind Resend's label covers the button under the words,
 *   led by a 2px edge, runs as long as
 *   the wait at an even pace, is empty as the label reads "Resend link", runs
 *   the whole wait again after a Resend from where it stands once the send
 *   ends, paints in light and dark, and is not drawn under reduced motion or
 *   forced colours. Its timing and those media queries need a real engine:
 *   happy-dom runs no transitions and matches no media.
 *
 * The view sits where `Register` puts it in musubi's create-account dialog:
 * `ResponsiveDialogContent` (a bottom sheet below `md`, full width with no
 * side border or padding), then `Register`'s root (`flex flex-col`) and the
 * body `ViewStep` draws for `host="dialog"`, padded 16px (`ViewParts.tsx`),
 * copied here; `AuthDialogs.browser.test.tsx` holds the real body's column to
 * the sheet's width less 32px, so the copy cannot drift unseen. At a 320px
 * viewport that leaves the view a 288px column.
 *
 * Each case writes a screenshot to `__screenshots__/` beside this file
 * (gitignored).
 */

import { CheckEmailView } from "@osn/auth-ui/CheckEmailView";
import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

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

/** The fill that empties behind Resend's label over the wait: the counting label's one hidden child. */
function waitFill(): HTMLElement | null {
  return (
    screen
      .queryByRole("button", { name: /^Resend in/ })
      ?.querySelector<HTMLElement>('span[aria-hidden="true"]') ?? null
  );
}

/**
 * Two frames on, every animation but the wait's fill has ended, and the faces
 * have loaded, so no box is read mid-animation or against fallback metrics.
 * The fill runs for the whole wait, so waiting on it would spend the wait.
 */
async function settled() {
  await nextFrame();
  await nextFrame();
  const fill = waitFill();
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => (animation.effect as KeyframeEffect | null)?.target !== fill)
      .map((animation) => animation.finished),
  );
  await document.fonts.ready;
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
  await settled();

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

  for (const [frame, viewport] of [
    ["the phone sheet", PHONE],
    ["the centred dialog", DESKTOP],
    ["a frame that grows downward", { width: 390, height: 844 }],
  ] as const) {
    it(`keeps "Start again" out from under a tap aimed at Resend as the junk-mail line arrives, in ${frame}`, async () => {
      await atViewport(viewport);
      const view = () => (
        <div class="mx-auto max-w-sm px-4 py-8">
          <CheckEmailView
            email={LONG_EMAIL}
            purpose="sign-up"
            productName="Musubi"
            status="waiting"
            resendWaitSeconds={1}
            onResend={() => {}}
            onChangeEmail={() => {}}
          />
        </div>
      );
      render(() =>
        frame === "a frame that grows downward" ? (
          <main class="p-4">{view()}</main>
        ) : (
          <Dialog open onOpenChange={() => {}}>
            <ResponsiveDialogContent aria-label="Check your email">
              {view()}
            </ResponsiveDialogContent>
          </Dialog>
        ),
      );
      await settled();

      const resend = screen.getByRole("button", { name: /^Resend in/ });
      const box = resend.getBoundingClientRect();
      const aim = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      expect(screen.queryByText(/^Can't find it\?/)).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await nextFrame();
      await nextFrame();
      const line = screen.getByText(/^Can't find it\?/);
      const changeEmail = screen.getByRole("button", { name: "Start again" });
      const hit = document.elementFromPoint(aim.x, aim.y);
      expect(hit).not.toBeNull();
      expect(changeEmail.contains(hit)).toBe(false);
      // The line sits directly above Resend.
      expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        screen.getByRole("button", { name: "Resend link" }).getBoundingClientRect().top,
      );

      await page.screenshot({ path: `${SHOTS}/junk-line-${viewport.width}.png` });
    });
  }
});

/** The fill's one transition: its `translate`, from in place to out at the start over the wait. */
function drain(fill: HTMLElement): CSSTransition {
  const transitions = fill.getAnimations().filter((a) => a instanceof CSSTransition);
  expect(transitions).toHaveLength(1);
  const run = transitions[0] as CSSTransition;
  expect(run.transitionProperty).toBe("translate");
  return run;
}

/** A colour the way the browser paints it: a `var()` chain resolved on a throwaway element. */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  document.body.append(probe);
  const painted = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return painted;
}

/** The view alone in musubi's sheet, on a wait of `seconds`, with Resend answered by `onResend`. */
async function mountWaiting(seconds: number, onResend: () => void | Promise<void> = () => {}) {
  render(() => (
    <Dialog open onOpenChange={() => {}}>
      <ResponsiveDialogContent aria-label="Check your email">
        <div class="flex flex-col gap-4 p-4">
          <CheckEmailView
            email="ada@example.com"
            purpose="sign-up"
            status="waiting"
            resendWaitSeconds={seconds}
            onResend={onResend}
            onChangeEmail={() => {}}
          />
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  ));
  await settled();
}

describe("the fill that empties behind Resend's label over the wait", () => {
  afterEach(async () => {
    document.documentElement.classList.remove("dark");
    await commands.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
  });

  for (const [viewport, height] of [
    [PHONE, 40],
    [DESKTOP, 32],
  ] as const) {
    it(`starts full and empties at an even pace over the whole wait, behind the label, at ${viewport.width}px`, async () => {
      await atViewport(viewport);
      await mountWaiting(30);

      const resend = screen.getByRole("button", { name: "Resend in 30s" });
      const fill = waitFill() as HTMLElement;
      // Inside the label, so the button still holds one child and the label
      // reads the same: no text, hidden from the accessibility tree.
      expect(resend.childElementCount).toBe(1);
      expect(fill.parentElement).toBe(resend.firstElementChild);
      expect(fill.textContent).toBe("");
      expect(resend.getBoundingClientRect().height).toBe(height);

      const run = drain(fill);
      const timing = run.effect?.getComputedTiming();
      expect(timing?.duration).toBe(30_000);
      expect(timing?.progress).toBeLessThan(0.02);
      expect(getComputedStyle(fill).transitionTimingFunction).toBe("linear");

      // The button's whole box, behind the label: under it in the button's own
      // stacking context, and clipped to the button's corners.
      const style = getComputedStyle(fill);
      expect([fill.offsetWidth, fill.offsetHeight]).toEqual([resend.offsetWidth, height]);
      expect(style.zIndex).toBe("-10");
      expect(getComputedStyle(resend).isolation).toBe("isolate");
      expect(getComputedStyle(resend).overflow).toBe("clip");
      // Its leading edge, a 2px line.
      expect([style.borderRightWidth, style.borderRightStyle]).toEqual(["2px", "solid"]);

      // Halfway, it is half full and its edge sits mid-button: the label's
      // seconds and the fill agree.
      run.pause();
      run.currentTime = 15_000 + Number(run.effect?.getTiming().delay ?? 0);
      await nextFrame();
      const button = resend.getBoundingClientRect();
      expect(fill.getBoundingClientRect().right - button.left).toBeCloseTo(button.width / 2, 0);
      run.play();
    });
  }

  it("empties on the deadline, as the label reads Resend link, and is gone with the countdown", async () => {
    await atViewport(PHONE);
    await mountWaiting(2);
    const fill = waitFill() as HTMLElement;
    const run = drain(fill);
    const start = Number(run.startTime);
    const delay = Number(run.effect?.getTiming().delay ?? 0);

    // How far the drain has run, read the moment the label changes, before the
    // page paints again. `performance.now()` and the document timeline share
    // one clock.
    const atUnlock = new Promise<number>((resolve) => {
      const watch = new MutationObserver(() => {
        if (!screen.queryByRole("button", { name: "Resend link" })) return;
        watch.disconnect();
        resolve((performance.now() - start - delay) / 2_000);
      });
      watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    // Within a tenth of the wait of the end, either side: the drain and the
    // label read one deadline, the drain on the frame clock, which may start
    // it a frame or more late on a loaded runner, and the label on the next
    // timer tick, which may land late.
    const progress = await atUnlock;
    expect(progress).toBeGreaterThan(0.9);
    expect(progress).toBeLessThan(1.1);
    expect(fill.isConnected).toBe(false);
    expect(waitFill()).toBeNull();
  });

  it("drains over the whole wait again after a Resend, from where the wait stands once the send ends", async () => {
    await atViewport(PHONE);
    let finishSend!: () => void;
    await mountWaiting(2, () => new Promise<void>((resolve) => (finishSend = resolve)));

    await expect
      .element(page.getByRole("button", { name: "Resend link" }), { timeout: 5_000 })
      .toBeInTheDocument();
    screen.getByRole("button", { name: "Resend link" }).click();
    // While it sends, Resend is busy, and no fill is drawn.
    await expect.element(page.getByRole("button", { name: "Sending…" })).toBeInTheDocument();
    const busy = screen.getByRole("button", { name: "Sending…" });
    expect(busy.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition)).toEqual(
      [],
    );

    // The wait began with the press; half a second of it goes on the send.
    await new Promise((resolve) => setTimeout(resolve, 500));
    finishSend();
    await expect.element(page.getByRole("button", { name: /^Resend in/ })).toBeInTheDocument();

    const timing = drain(waitFill() as HTMLElement).effect?.getComputedTiming();
    expect(timing?.duration).toBe(2_000);
    expect(timing?.progress).toBeGreaterThan(0.2);
    expect(timing?.progress).toBeLessThan(0.4);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const viewport of [PHONE, DESKTOP]) {
      it(`paints the ghost button's own fill, led by an edge in the faintest ink, in ${theme} at ${viewport.width}px`, async () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
        await atViewport(viewport);
        await mountWaiting(4);

        const fill = waitFill() as HTMLElement;
        const style = getComputedStyle(fill);
        expect(style.display).not.toBe("none");
        expect(style.backgroundColor).toBe(paint("var(--ui-surface-sunk)"));
        expect(style.borderRightColor).toBe(paint("var(--ui-ink-tertiary)"));
        expect(style.backgroundColor).not.toBe(
          getComputedStyle(screen.getByRole("dialog")).backgroundColor,
        );

        // The run: a frame as each second's label lands, then unlocked. A slow
        // shot may miss a second; the frames are what the page showed.
        const shot = new Set<string>();
        while (!screen.queryByRole("button", { name: "Resend link" })) {
          const seconds = screen
            .queryByRole("button", { name: /^Resend in \d+s$/ })
            ?.textContent?.match(/\d+/)?.[0];
          if (seconds && !shot.has(seconds)) {
            shot.add(seconds);
            await page.screenshot({
              path: `${SHOTS}/wait-fill-${theme}-${viewport.width}-${seconds}s.png`,
            });
          }
          await nextFrame();
        }
        expect(shot.has("4")).toBe(true);
        await page.screenshot({
          path: `${SHOTS}/wait-fill-${theme}-${viewport.width}-unlocked.png`,
        });
      });
    }
  }

  it("draws no fill under reduced motion, and the label still counts", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    await atViewport(PHONE);
    await mountWaiting(30);

    const resend = screen.getByRole("button", { name: "Resend in 30s" });
    const fill = waitFill() as HTMLElement;
    expect(getComputedStyle(fill).display).toBe("none");
    expect(fill.getAnimations()).toHaveLength(0);
    expect((resend.firstElementChild as HTMLElement).getClientRects()).toHaveLength(1);

    await page.screenshot({ path: `${SHOTS}/wait-fill-reduced-motion-320.png` });
  });

  it("draws no fill under forced colours, and the label stays on show", async () => {
    await commands.emulateMedia({ forcedColors: "active" });
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    await atViewport(PHONE);
    await mountWaiting(30);

    const resend = screen.getByRole("button", { name: "Resend in 30s" });
    expect(getComputedStyle(waitFill() as HTMLElement).display).toBe("none");
    const label = resend.firstElementChild as HTMLElement;
    expect(label.getClientRects()).toHaveLength(1);
    expect(label.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(getComputedStyle(label).color).not.toBe("rgba(0, 0, 0, 0)");

    await page.screenshot({ path: `${SHOTS}/wait-fill-forced-colours-320.png` });
  });
});
