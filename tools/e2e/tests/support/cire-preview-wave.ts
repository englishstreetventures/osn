/**
 * The invite builder's narrow preview and its two waves (`@cire/waves`,
 * `cire/host/src/components/invite/NarrowPreview.tsx`), on a phone, 390×844.
 * Shots go to `screenshots/cire-invite-preview-wave/`.
 *
 * A place the `cire-soft-shapes` flow already stands, so it signs in no more
 * than it did: the organiser's builder, on Content.
 *
 * - **Gilded** (the default): the wave is held at three points of its run
 *   through the page's development hook (`window.__cireWaves.holdGilded`),
 *   since its hand-over is a View Transition whose animations run on the
 *   document timeline, which Playwright's clock does not hold. Each held frame
 *   is shot with animations allowed: disabling them would end the transition.
 *   Released, the frame shows the composed preview with focus on it (the
 *   region "Live preview"), the builder under it inert and the button reading
 *   "Back to editing"; Back is held once on its way out too, then runs to the
 *   end, and the builder is live again with focus back on the button.
 * - **Distortion** (`?preview-wave=distortion`): the form column is the wave's
 *   first view. Its controller is read through `window.__cireWaves.distortion`;
 *   with the page clock paused mid-run, the canvas is shown and the wave
 *   running. Run to the end, the preview view is live and the form inert; Back
 *   returns the page to where it was scrolled. Its run is a function of the
 *   frame's time from the first, so the paused clock jumps over the rest of a
 *   run rather than drawing every frame of it in software GL, which keeps the
 *   `cire-soft-shapes` flow inside its two minutes.
 * - Around Gilded: the frame lies under the bar and follows it as the page
 *   moves; the mask is centred on the button; Escape goes back; Back pressed
 *   while the gold still runs turns the wave; a section chosen, or a wide
 *   window, closes it at once; with either wave's module refused, the frame
 *   opens bare. Around Distortion: opening brings the column's top under the
 *   bar, Escape on the button goes back, and the page returns to where it was
 *   scrolled; a section chosen closes it at once; a wide window, or Codes,
 *   takes the column out of the wave and back.
 * - **Reduced motion**, once each: no transition and no canvas, a fade. The
 *   Gilded one opens from the keyboard, so focus lands with the house ring.
 *
 * Only what repeats run to run is checked; the held frames are pictures.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-invite-preview-wave");
const PHONE = { width: 390, height: 844 } as const;
const HELD = [0.18, 0.32, 0.5] as const;
const FRAME = "[data-preview-frame]";
const WAVE = "[data-distortion-wave]";
const GILDED_MODULE = "**/cire/waves/src/gilded/gilded.ts*";
const DISTORTION_MODULE = "**/cire/waves/src/distortion/DistortionWave.tsx*";

/** The page's development hook, as `@cire/waves` writes it. */
interface Hooks {
  holdGilded(p: number): Promise<void>;
  releaseGilded(): void;
  distortion(): {
    running: boolean;
    mode: string | null;
    webgl: boolean;
    content: { ready: boolean };
    revealed: { ready: boolean };
  } | null;
}
type WithHooks = Window & { __cireWaves?: Partial<Hooks> };

/** `astro dev` draws its own toolbar over the page; it is not the page. */
const HIDE_DEV_TOOLBAR = "astro-dev-toolbar { display: none !important; }";

async function hold(page: Page, p: number): Promise<void> {
  await page.evaluate((at) => (window as WithHooks).__cireWaves!.holdGilded!(at), p);
}

/** The Gilded transition is up and its mask cut on the front. */
async function waveHeld(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.documentElement.style.getPropertyValue("--cire-gilded-mask").startsWith("radial-"),
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), animations: "allow" });
}

async function builderInert(page: Page): Promise<boolean> {
  return page
    .getByRole("heading", { name: "Customise your invite" })
    .evaluate((el) => el.closest("section")?.hasAttribute("inert") ?? false);
}

/** The focused element's tag and name: its `aria-label`, or its words. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return "none";
    const name = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
    return `${el.tagName.toLowerCase()} ${name}`;
  });
}

/** Whether the page carries the Gilded transition's class. */
async function gildedClass(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("cire-gilded"));
}

/** Whether Distortion's view `which` is inert. */
async function layerInert(page: Page, which: "content" | "revealed"): Promise<boolean> {
  return page
    .locator(`${WAVE} > [data-dw-layer="${which}"]`)
    .evaluate((el) => el.hasAttribute("inert"));
}

/**
 * Runs a Distortion wave the paused page clock has just started to its end:
 * one frame starts the run's clock, the jump draws the next past the run's
 * length, which ends it. Leaves the clock running again.
 */
async function distortionToEnd(page: Page): Promise<void> {
  await page.clock.runFor(32);
  await page.clock.fastForward(6000);
  await page.clock.resume();
  await page.waitForFunction(
    () => (window as WithHooks).__cireWaves?.distortion?.()?.running === false,
    undefined,
    { timeout: 15_000 },
  );
}

/** Chooses a view or a section from the phone's place menu. */
async function choosePlace(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name: /Choose a view or section/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

/** The frame lies under the view bar, across it, to the window's foot. */
async function frameUnderBar(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-preview-frame]")?.getBoundingClientRect();
    const bar = document.querySelector("[data-view-bar]")?.getBoundingClientRect();
    if (!frame || !bar) return false;
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    return (
      near(frame.top, bar.bottom) &&
      near(frame.left, bar.left) &&
      near(frame.width, bar.width) &&
      near(frame.bottom, window.innerHeight)
    );
  });
}

/** The held mask's circle sits on the middle of the Preview button. */
async function maskOnButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const mask = document.documentElement.style.getPropertyValue("--cire-gilded-mask");
    const at = /circle at ([\d.-]+)px ([\d.-]+)px/.exec(mask);
    const frame = document.querySelector("[data-preview-frame]")?.getBoundingClientRect();
    const button = [...document.querySelectorAll("[data-view-bar] button")]
      .find(
        (b) => b.textContent?.trim() === "Preview" || b.textContent?.trim() === "Back to editing",
      )
      ?.getBoundingClientRect();
    if (!at || !frame || !button) return false;
    const x = button.left + button.width / 2 - frame.left;
    const y = button.top + button.height / 2 - frame.top;
    return Math.abs(Number(at[1]) - x) <= 1 && Math.abs(Number(at[2]) - y) <= 1;
  });
}

async function openBuilder(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.addStyleTag({ content: HIDE_DEV_TOOLBAR });
  await expect(page.getByRole("heading", { name: "Customise your invite" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
}

/**
 * `origin` is the host portal's; `wedding` the wedding whose builder opens.
 * Leaves the page at the viewport it found, with motion back on.
 */
export async function builderPreviewWave(
  flow: Flow,
  page: Page,
  origin: string,
  wedding: string,
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const before = page.viewportSize();
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  const back = page.getByRole("button", { name: "Back to editing" });
  const frame = page.locator(FRAME);
  const gildedUrl = `${origin}/#/w/${wedding}/invite/content`;
  const distortionUrl = `${origin}/?preview-wave=distortion#/w/${wedding}/invite/content`;
  // A query of their own, so each is a new document that has not loaded the module.
  const refusedUrl = `${origin}/?refused#/w/${wedding}/invite/content`;
  const refusedDistortionUrl = `${origin}/?preview-wave=distortion&refused#/w/${wedding}/invite/content`;

  try {
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // ── Gilded ───────────────────────────────────────────────────────────
    await flow.step("preview wave: open the builder on a phone", () =>
      openBuilder(page, gildedUrl),
    );
    flow.check("preview wave (gilded): no frame while closed", 0, await frame.count());

    await flow.step("preview wave: hold the Gilded wave and press Preview", async () => {
      // The pointer on the button warms the wave's import, which brings the hook.
      await preview.hover();
      await page.waitForFunction(() => !!(window as WithHooks).__cireWaves?.holdGilded);
      await hold(page, HELD[0]);
      await preview.click();
      await waveHeld(page);
    });
    flow.check(
      "preview wave (gilded): the transition runs under its own class",
      true,
      await gildedClass(page),
    );
    flow.check(
      "preview wave (gilded): the frame's picture is the one named",
      "cire-gilded-frame",
      await frame.evaluate((el) => (el as HTMLElement).style.viewTransitionName),
    );
    flow.check(
      "preview wave (gilded): the gold is drawn on its canvas",
      1,
      await page.locator("canvas[data-gilded-fx]").count(),
    );
    flow.check(
      "preview wave (gilded): the frame lies under the view bar, across it, to the foot",
      true,
      await frameUnderBar(page),
    );
    flow.check(
      "preview wave (gilded): the mask's circle is centred on the Preview button",
      true,
      await maskOnButton(page),
    );
    for (const p of HELD) {
      await flow.step(`preview wave: shoot the Gilded wave at ${p}`, async () => {
        await hold(page, p);
        await shot(page, `gilded-${p.toFixed(2)}`);
      });
    }

    await flow.step("preview wave: let the Gilded wave go", async () => {
      await page.evaluate(() => (window as WithHooks).__cireWaves!.releaseGilded!());
      await expect(back).toBeVisible();
      await expect(frame).toBeVisible();
      await shot(page, "gilded-open");
    });
    flow.check(
      "preview wave (gilded): the transition's class is gone",
      false,
      await gildedClass(page),
    );
    flow.check(
      "preview wave (gilded): the frame holds the composed preview",
      1,
      await frame.getByRole("figure", { name: "Invite preview" }).count(),
    );
    flow.check(
      "preview wave (gilded): the builder is inert under it",
      true,
      await builderInert(page),
    );
    flow.check(
      "preview wave (gilded): focus on the preview",
      "section Live preview",
      await focused(page),
    );

    const heldBack = await flow.step(
      "preview wave: hold Back on its way out, then let it go",
      async () => {
        await hold(page, HELD[1]);
        await back.click();
        await waveHeld(page);
        await shot(page, `gilded-back-${HELD[1].toFixed(2)}`);
        // The words change at the hand-over, not at the press.
        const words = await back.count();
        await page.evaluate(() => (window as WithHooks).__cireWaves!.releaseGilded!());
        await expect(frame).toHaveCount(0);
        await expect(preview).toBeVisible();
        return words;
      },
    );
    flow.check(
      "preview wave (gilded): held on its way back, the button still says Back",
      1,
      heldBack,
    );
    flow.check(
      "preview wave (gilded): the canvas goes with the frame",
      0,
      await page.locator("canvas[data-gilded-fx]").count(),
    );
    flow.check("preview wave (gilded): the builder is live again", false, await builderInert(page));
    flow.check(
      "preview wave (gilded): focus back on the button",
      "button Preview",
      await focused(page),
    );

    await flow.step("preview wave: run the Gilded wave out unheld", async () => {
      await preview.click();
      await expect(back).toBeVisible({ timeout: 10_000 });
      await expect(frame).toBeVisible();
    });
    const followed = await flow.step(
      "preview wave: scroll the page under the open frame",
      async () => {
        const barFoot = await page.evaluate(
          () => document.querySelector("[data-view-bar]")!.getBoundingClientRect().bottom,
        );
        await page.evaluate(() => window.scrollBy(0, 120));
        await page.waitForFunction(
          (was) =>
            document.querySelector("[data-view-bar]")!.getBoundingClientRect().bottom !== was,
          barFoot,
        );
        await expect.poll(() => frameUnderBar(page)).toBe(true);
        return true;
      },
    );
    flow.check(
      "preview wave (gilded): the frame follows the bar as the page moves",
      true,
      followed,
    );
    await flow.step("preview wave: Escape inside the frame runs it back", async () => {
      await page.keyboard.press("Escape");
      await expect(frame).toHaveCount(0, { timeout: 10_000 });
      await expect(preview).toBeFocused();
    });

    const tail = await flow.step(
      "preview wave: Back pressed while the gold still runs turns the wave",
      async () => {
        await preview.click();
        // The hand-over: the frame is live, the gold still fading on it.
        await expect(back).toBeVisible({ timeout: 10_000 });
        // Held in its tail, so the press lands with the run still going.
        await hold(page, 0.7);
        const gold = await page
          .locator("canvas[data-gilded-fx]")
          .evaluate((el) => (el as HTMLElement).style.display);
        await back.click();
        // The run in flight ended where it was going, and the wave back started.
        await waveHeld(page);
        await page.evaluate(() => (window as WithHooks).__cireWaves!.releaseGilded!());
        await expect(frame).toHaveCount(0);
        await expect(preview).toBeVisible();
        return gold;
      },
    );
    flow.check("preview wave (gilded): the gold still runs when Back is pressed", "block", tail);
    flow.check(
      "preview wave (gilded): turned mid-run, the transition's class is gone",
      false,
      await gildedClass(page),
    );
    flow.check(
      "preview wave (gilded): turned mid-run, the builder is live again",
      false,
      await builderInert(page),
    );
    flow.check(
      "preview wave (gilded): turned mid-run, focus back on the button",
      "button Preview",
      await focused(page),
    );

    await flow.step("preview wave: choosing a section closes it at once", async () => {
      await preview.click();
      await expect(back).toBeVisible({ timeout: 10_000 });
      await choosePlace(page, /^Welcome/);
      await expect(frame).toHaveCount(0);
      await expect(preview).toBeVisible();
    });
    flow.check(
      "preview wave (gilded): closed by a section, the builder is live",
      false,
      await builderInert(page),
    );
    await flow.step("preview wave: it opens again after, and a wide window closes it", async () => {
      await preview.click();
      await expect(back).toBeVisible({ timeout: 10_000 });
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(frame).toHaveCount(0);
      await expect(preview).toHaveCount(0);
      await page.setViewportSize(PHONE);
      await expect(preview).toBeVisible();
    });
    flow.check(
      "preview wave (gilded): closed by a wide window, the builder is live",
      false,
      await builderInert(page),
    );

    await flow.step(
      "preview wave: with the wave's module refused, the frame opens bare",
      async () => {
        await page.route(GILDED_MODULE, (route) => route.abort());
        await openBuilder(page, refusedUrl);
        await preview.click();
        await expect(frame).toBeVisible();
        await expect(back).toBeVisible();
      },
    );
    flow.check(
      "preview wave (gilded, module refused): no transition",
      false,
      await gildedClass(page),
    );
    flow.check(
      "preview wave (gilded, module refused): the builder is inert under the frame",
      true,
      await builderInert(page),
    );
    await flow.step("preview wave: back from the bare frame", async () => {
      await back.click();
      await expect(frame).toHaveCount(0);
      await page.unroute(GILDED_MODULE);
    });

    await flow.step(
      "preview wave: on Distortion's page with its module refused, the frame opens bare",
      async () => {
        await page.route(DISTORTION_MODULE, (route) => route.abort());
        await openBuilder(page, refusedDistortionUrl);
        await preview.click();
        await expect(frame).toBeVisible();
        await expect(back).toBeVisible();
      },
    );
    flow.check(
      "preview wave (distortion, module refused): no wave on the page",
      0,
      await page.locator(WAVE).count(),
    );
    flow.check(
      "preview wave (distortion, module refused): the builder is inert under the frame",
      true,
      await builderInert(page),
    );
    await flow.step("preview wave: back from Distortion's bare frame", async () => {
      await back.click();
      await expect(frame).toHaveCount(0);
      await expect(preview).toBeVisible();
      await page.unroute(DISTORTION_MODULE);
    });
    flow.check(
      "preview wave (distortion, module refused): back, the builder is live",
      false,
      await builderInert(page),
    );

    // ── Distortion ───────────────────────────────────────────────────────
    await flow.step("preview wave: open the builder with Distortion", async () => {
      await openBuilder(page, distortionUrl);
      await expect(page.locator(WAVE)).toHaveCount(1);
      // Prewarm takes both pictures at idle after mounting, as upstream does.
      await page.waitForFunction(
        () => {
          const d = (window as WithHooks).__cireWaves?.distortion?.();
          return !!d && d.content.ready && d.revealed.ready;
        },
        undefined,
        { timeout: 30_000 },
      );
    });
    flow.check(
      "preview wave (distortion): the form column is the wave's first view",
      1,
      await page.locator(`${WAVE} [data-dw-layer="content"] #invite-design`).count(),
    );
    // Down the page, so opening has to bring the column's top under the bar.
    const scrolledBefore = await page.evaluate(() => {
      window.scrollTo(0, 400);
      return window.scrollY;
    });
    // Only whether it moved goes on the record: how far is the page's height.
    flow.check(
      "preview wave (distortion): the page is scrolled down first",
      true,
      scrolledBefore > 0,
    );

    await flow.step("preview wave: press Preview with the clock paused mid-run", async () => {
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
      await preview.click();
      // A frame starts the run's clock; the jump draws the next at 1.5 s.
      await page.clock.runFor(32);
      await page.clock.fastForward(1468);
      await shot(page, "distortion-1.5s");
    });
    flow.check(
      "preview wave (distortion): opening brings the column's top under the bar",
      true,
      await page.evaluate(() => {
        const wave = document.querySelector("[data-distortion-wave]")!.getBoundingClientRect();
        const bar = document.querySelector("[data-view-bar]")!.getBoundingClientRect();
        return Math.abs(wave.top - bar.bottom) <= 1;
      }),
    );
    const midRun = await page.evaluate(() => (window as WithHooks).__cireWaves!.distortion!());
    flow.check(
      "preview wave (distortion): the wave is running mid-run",
      true,
      midRun?.running ?? false,
    );
    flow.check(
      "preview wave (distortion): its canvas shows",
      "block",
      await page.locator(`${WAVE} > canvas`).evaluate((el) => (el as HTMLElement).style.display),
    );
    flow.check("preview wave (distortion): the label changed at the press", 1, await back.count());

    await flow.step("preview wave: run Distortion to the end", async () => {
      await distortionToEnd(page);
      await shot(page, "distortion-open");
    });
    flow.check(
      "preview wave (distortion): the form column is inert under the preview",
      true,
      await layerInert(page, "content"),
    );
    flow.check(
      "preview wave (distortion): the preview view is live",
      false,
      await layerInert(page, "revealed"),
    );
    flow.check(
      "preview wave (distortion): focus on the preview",
      "section Live preview",
      await focused(page),
    );

    await flow.step("preview wave: Escape on the button goes back from Distortion", async () => {
      await back.focus();
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
      await page.keyboard.press("Escape");
      await expect(preview).toBeVisible();
      await distortionToEnd(page);
    });
    flow.check(
      "preview wave (distortion): the page is back where it was scrolled",
      true,
      (await page.evaluate(() => window.scrollY)) === scrolledBefore,
    );

    await flow.step(
      "preview wave: choosing a section closes Distortion's preview at once",
      async () => {
        // Chosen while the wave still runs: it lasts about four seconds.
        await preview.click();
        await expect(back).toBeVisible();
        await choosePlace(page, /^Welcome/);
        await expect(preview).toBeVisible();
      },
    );
    // At once: no wave runs back (that one would take about three seconds).
    flow.check(
      "preview wave (distortion): closed by a section, no wave runs back",
      false,
      (await page.evaluate(() => (window as WithHooks).__cireWaves!.distortion!()))?.running ??
        true,
    );
    flow.check(
      "preview wave (distortion): closed by a section, the form column is live",
      false,
      await layerInert(page, "content"),
    );
    flow.check(
      "preview wave (distortion): closed by a section, the preview view is inert",
      true,
      await layerInert(page, "revealed"),
    );
    flow.check(
      "preview wave (distortion): closed by a section, it shows",
      true,
      await page.locator("#invite-welcome").isVisible(),
    );

    // The column moves out of the wave and back whenever the preview cannot
    // open, and must come back whole and live each way.
    const column = page.locator("#invite-welcome");
    const outOfWave = () =>
      column.evaluate((el) => !el.closest("[data-distortion-wave]") && !el.closest("[inert]"));
    const inWave = () =>
      page.locator(`${WAVE} > [data-dw-layer="content"]:not([inert]) #invite-welcome`).count();
    await flow.step(
      "preview wave: a wide window takes the column out of Distortion's wave",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.locator(WAVE)).toHaveCount(0);
        await expect(column).toBeVisible();
      },
    );
    flow.check(
      "preview wave (distortion): wide, the column stands outside the wave",
      true,
      await outOfWave(),
    );
    await flow.step("preview wave: back on a phone, the column is the wave's again", async () => {
      await page.setViewportSize(PHONE);
      await expect(page.locator(WAVE)).toHaveCount(1);
      await expect(column).toBeVisible();
    });
    flow.check(
      "preview wave (distortion): on a phone again, the column is the wave's first view",
      1,
      await inWave(),
    );
    await flow.step("preview wave: Codes takes the column out of Distortion's wave", async () => {
      await choosePlace(page, /^Codes/);
      await expect(page.locator(WAVE)).toHaveCount(0);
      await expect(preview).toHaveCount(0);
    });
    flow.check(
      "preview wave (distortion): on Codes, the column stands outside the wave",
      true,
      await column.evaluate(
        (el) => !el.closest("[data-distortion-wave]") && !el.closest("[inert]"),
      ),
    );
    await flow.step("preview wave: back on Content, the column is the wave's again", async () => {
      await choosePlace(page, /^Content/);
      await expect(page.locator(WAVE)).toHaveCount(1);
      await expect(preview).toBeVisible();
    });
    flow.check(
      "preview wave (distortion): on Content again, the column is the wave's first view",
      1,
      await inWave(),
    );

    // ── Reduced motion ───────────────────────────────────────────────────
    await page.emulateMedia({ reducedMotion: "reduce" });
    const faded = await flow.step("preview wave: Distortion under reduced motion", async () => {
      // Paused, so the 300 ms crossfade is still running when it is read.
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
      await preview.click();
      const mode = (await page.evaluate(() => (window as WithHooks).__cireWaves!.distortion!()))
        ?.mode;
      await page.clock.resume();
      await expect(back).toBeVisible();
      return mode ?? "none";
    });
    flow.check("preview wave (distortion, reduced motion): a crossfade", "fade", faded);
    await flow.step("preview wave: back from Distortion under reduced motion", async () => {
      await back.click();
      await expect(preview).toBeVisible();
    });

    const ring = await flow.step(
      "preview wave: Gilded under reduced motion, opened from the keyboard",
      async () => {
        await openBuilder(page, gildedUrl);
        await preview.focus();
        await page.keyboard.press("Enter");
        await expect(frame).toBeVisible();
        await expect(frame).toBeFocused();
        return frame.evaluate((el) => {
          const style = getComputedStyle(el);
          return (
            el.matches(":focus-visible") &&
            style.outlineStyle === "solid" &&
            Number.parseFloat(style.outlineOffset) < 0
          );
        });
      },
    );
    flow.check(
      "preview wave (gilded, by key): focus lands on the preview with the house ring inside its edge",
      true,
      ring,
    );
    flow.check(
      "preview wave (gilded, reduced motion): no transition",
      false,
      await gildedClass(page),
    );
    flow.check(
      "preview wave (gilded, reduced motion): no canvas",
      0,
      await page.locator("canvas[data-gilded-fx]").count(),
    );
    await flow.step("preview wave: back from Gilded under reduced motion", async () => {
      await expect(back).toBeVisible();
      await back.click();
      await expect(frame).toHaveCount(0);
    });
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (before) await page.setViewportSize(before);
  }
}
