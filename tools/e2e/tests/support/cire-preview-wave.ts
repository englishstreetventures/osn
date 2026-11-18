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
 *   Released, the frame shows the composed preview with focus on its heading,
 *   the builder under it inert and the button reading "Back to editing"; Back
 *   is held once on its way out too, then runs to the end, and the builder is
 *   live again with focus back on the button.
 * - **Distortion** (`?preview-wave=distortion`): the form column is the wave's
 *   first view. Its controller is read through `window.__cireWaves.distortion`;
 *   with the page clock paused mid-run, the canvas is shown and the wave
 *   running. Run to the end, the preview view is live and the form inert; Back
 *   returns the page to where it was scrolled.
 * - **Reduced motion**, once each: no transition and no canvas, a fade.
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

async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()} ${el.textContent?.trim() ?? ""}` : "none";
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
      await page.evaluate(() => document.documentElement.classList.contains("cire-gilded")),
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
      await page.evaluate(() => document.documentElement.classList.contains("cire-gilded")),
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
      "preview wave (gilded): focus on the preview's heading",
      "h2 Live preview",
      await focused(page),
    );

    await flow.step("preview wave: hold Back on its way out, then let it go", async () => {
      await hold(page, HELD[1]);
      await back.click();
      await waveHeld(page);
      await shot(page, `gilded-back-${HELD[1].toFixed(2)}`);
      await page.evaluate(() => (window as WithHooks).__cireWaves!.releaseGilded!());
      await expect(frame).toHaveCount(0);
      await expect(preview).toBeVisible();
    });
    flow.check("preview wave (gilded): the builder is live again", false, await builderInert(page));
    flow.check(
      "preview wave (gilded): focus back on the button",
      "button Preview",
      await focused(page),
    );

    await flow.step("preview wave: run the Gilded wave out and back unheld", async () => {
      await preview.click();
      await expect(back).toBeVisible({ timeout: 10_000 });
      await expect(frame).toBeVisible();
      await back.click();
      await expect(frame).toHaveCount(0, { timeout: 10_000 });
    });

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
    const scrolledBefore = await page.evaluate(() => window.scrollY);

    await flow.step("preview wave: press Preview with the clock paused mid-run", async () => {
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
      await preview.click();
      await page.clock.runFor(1500);
      await shot(page, "distortion-1.5s");
    });
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
      await page.clock.resume();
      await page.waitForFunction(
        () => (window as WithHooks).__cireWaves?.distortion?.()?.running === false,
        undefined,
        { timeout: 15_000 },
      );
      await shot(page, "distortion-open");
    });
    flow.check(
      "preview wave (distortion): the form column is inert under the preview",
      true,
      await page
        .locator(`${WAVE} > [data-dw-layer="content"]`)
        .evaluate((el) => el.hasAttribute("inert")),
    );
    flow.check(
      "preview wave (distortion): the preview view is live",
      false,
      await page
        .locator(`${WAVE} > [data-dw-layer="revealed"]`)
        .evaluate((el) => el.hasAttribute("inert")),
    );

    await flow.step("preview wave: go back from Distortion", async () => {
      await back.click();
      await expect(preview).toBeVisible();
      await page.waitForFunction(
        () => (window as WithHooks).__cireWaves?.distortion?.()?.running === false,
        undefined,
        { timeout: 15_000 },
      );
    });
    flow.check(
      "preview wave (distortion): the page is back where it was scrolled",
      scrolledBefore,
      await page.evaluate(() => window.scrollY),
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

    await flow.step("preview wave: Gilded under reduced motion", async () => {
      await openBuilder(page, gildedUrl);
      await preview.click();
      await expect(frame).toBeVisible();
    });
    flow.check(
      "preview wave (gilded, reduced motion): no transition",
      false,
      await page.evaluate(() => document.documentElement.classList.contains("cire-gilded")),
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
