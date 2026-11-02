/**
 * Cire: the envelope opening on the guest invite (`@cire/envelope`).
 *
 * The seeded envelope wedding (`CIRE_ORGANISER.envelope`, on Crimson with the
 * Wax seal over a hero with a cropped image) opens as a guest on a Pixel 7
 * profile, in Chromium with HTML-in-Canvas switched on
 * (`--enable-blink-features=CanvasDrawElement`; Chromium turns it on by
 * default from 157). The flow:
 *
 * 1. warms `astro dev`'s compile of the scene modules, so the first real
 *    opening is not racing the boot script's 3 s readiness watchdog on a cold
 *    dev server;
 * 2. opens the invite: sealed, covered, waiting behind the consent prompt and
 *    ignoring a tap until it is answered, then armed, with focus on its button;
 * 3. waits for the idle prompt words;
 * 4. taps with the page clock paused: one haptic, the split break; a second
 *    tap speeds it up and it lands within 1000 ms of page time, on a last frame
 *    that matches the hero underneath;
 * 5. reloads to no envelope, and replays from the footer button with the peel
 *    (a tap) and the crumble (Enter);
 * 6. checks reduced motion and a browser without the API get the page as it
 *    is, with no attribute and no overlay;
 * 7. checks the page as it is after each failure: the scene module refused,
 *    and the WebGL context lost mid-opening; and that a consent prompt that
 *    never mounts still lets the envelope open after 8 s;
 * 8. opens an envelope over a hero with no image;
 * 9. checks a wedding with a shown hero and no envelope: capable, no key,
 *    nothing drawn.
 *
 * Every other flow runs with the API taken away (`NO_HTML_IN_CANVAS`, the
 * fixture's default); this one sets `envelope: true`. It claims nothing.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { chromium, devices, type BrowserContext, type Page } from "@playwright/test";

import { resolveChromium } from "../../src/chromium";
import { CIRE_ORGANISER, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, NO_HTML_IN_CANVAS, test, type Flow } from "../support/fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-invite-envelope");
const INVITE = `${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_ORGANISER.envelope.slug}`;
const PLAIN = `${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_ORGANISER.envelope.plainSlug}`;
const NO_ENVELOPE = `${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_ORGANISER.envelope.noneSlug}`;
const PHONE = devices["Pixel 7"];
const OVERLAY = "[data-envelope-overlay]";
const SEEN_PREFIX = "cire:envelope:";
/** At most this share of the frame's pixels may differ by more than 16 of 255 in any channel. */
const HANDOVER_TOLERANCE = 0.005;

let bundled: string | undefined;
try {
  bundled = chromium.executablePath();
} catch {
  bundled = undefined;
}

test.use({
  envelope: true,
  ...PHONE,
  launchOptions: {
    executablePath: resolveChromium(process.env, bundled),
    args: ["--enable-blink-features=CanvasDrawElement"],
  },
});

/** The `<html>` envelope state and the seen flag, as one record. */
async function envelopeState(page: Page) {
  return page.evaluate((prefix) => {
    const root = document.documentElement;
    const overlay = document.querySelector<HTMLElement>("[data-envelope-overlay]");
    const flags = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
    return {
      state: root.getAttribute("data-envelope"),
      capable: root.hasAttribute("data-envelope-capable"),
      key: root.getAttribute("data-envelope-key"),
      overlay: overlay !== null,
      phase: overlay?.dataset["phase"] ?? null,
      seen:
        flags.length === 1 ? localStorage.getItem(flags[0]!) : flags.length === 0 ? null : "many",
    };
  }, SEEN_PREFIX);
}

/**
 * Keeps `astro dev`'s toolbar out of the screenshots: it is not part of the
 * page a guest gets, and it sits over the prompt words.
 */
const HIDE_DEV_TOOLBAR = `document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = "astro-dev-toolbar{display:none!important}";
  document.head.append(style);
});`;

/** Console errors and uncaught page errors, kept per page. */
function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Answers the first-visit consent prompt with "Reject all". */
async function rejectConsent(page: Page): Promise<void> {
  const prompt = page.getByRole("dialog", { name: "Privacy choices" });
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await prompt.getByRole("button", { name: "Reject all" }).click();
  await expect(prompt).toBeHidden();
}

async function waitForState(page: Page, state: string | null): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-envelope")), {
      timeout: 30_000,
    })
    .toBe(state);
}

/** Stops the page clock where it is, so frames advance only through `runFor`. */
async function pauseClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 16);
}

/**
 * Plays one opening to the end with the page clock paused: start it, run
 * `midMs` of page time and screenshot the break, then run to the landing.
 */
async function playOpening(
  flow: Flow,
  page: Page,
  input: { style: string; how: "tap" | "enter"; midMs: number; shot: string },
): Promise<void> {
  await expect(page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
  await pauseClock(page);
  if (input.how === "tap") await page.locator(`${OVERLAY} button`).tap();
  else await page.keyboard.press("Enter");
  await page.clock.runFor(input.midMs);
  flow.check(
    `${input.style}: the seal breaks`,
    "breaking",
    (await envelopeState(page)).phase ?? "none",
  );
  await page.screenshot({ path: resolve(SHOTS, input.shot) });
  await page.clock.runFor(3000 - input.midMs);
  flow.check(
    `${input.style}: lands within 3000 ms at rate 1`,
    "open",
    (await envelopeState(page)).state ?? "none",
  );
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.clock.resume();
}

async function newPhonePage(
  flow: Flow,
  browser: import("@playwright/test").Browser,
  options: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {},
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ ...PHONE, ...options });
  const page = await flow.newPage(context);
  return { context, page, errors: consoleErrors(page) };
}

test("cire-invite-envelope", async ({ page, context, browser, flow }) => {
  // Many contexts and four openings, on SwiftShader in CI: three times the
  // suite's per-flow limit.
  test.slow();
  mkdirSync(SHOTS, { recursive: true });
  await context.addInitScript(HIDE_DEV_TOOLBAR);
  const errors = consoleErrors(page);

  await flow.step("warm the dev server's scene modules", async () => {
    const warm = await newPhonePage(flow, browser);
    await warm.page.goto(`${INVITE}&envelope=1`);
    // Either way is fine here: ready, or given up on by the watchdog.
    await expect
      .poll(
        () => warm.page.evaluate(() => document.documentElement.getAttribute("data-envelope")),
        {
          timeout: 90_000,
        },
      )
      .not.toBe("sealed");
    await warm.context.close();
  });

  await flow.step("a first visit is sealed, behind the consent prompt", async () => {
    await page.goto(`${INVITE}&envelope-break=split`);
    await waitForState(page, "ready");
    const state = await envelopeState(page);
    flow.check("the browser can play the opening", true, state.capable);
    flow.check("the server gave a hashed key", true, /^[0-9a-f]{64}$/.test(state.key ?? ""));
    flow.check("the key holds no part of the slug", false, (state.key ?? "").includes("envelope"));
    flow.check(
      "waits for the consent answer",
      false,
      (await page.locator(`${OVERLAY}[data-armed]`).count()) > 0,
    );
    // The consent dialog makes the overlay inert, so a real tap cannot reach
    // it; a click dispatched on the button stands for one that did.
    await page.locator(`${OVERLAY} button`).dispatchEvent("click");
    flow.check(
      "a tap before the answer does nothing",
      "sealed",
      (await envelopeState(page)).phase ?? "none",
    );
    await rejectConsent(page);
    await expect(page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
    flow.check(
      "the overlay covers the hero",
      true,
      await page.evaluate(() => {
        const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return hit?.closest("[data-envelope-overlay]") !== null;
      }),
    );
    flow.check(
      "the overlay's button has focus",
      true,
      await page.evaluate(
        () => document.activeElement?.closest("[data-envelope-overlay]") !== null,
      ),
    );
    await page.screenshot({ path: resolve(SHOTS, "01-sealed.png") });
  });

  await flow.step("the prompt words appear when the guest waits", async () => {
    await expect(page.locator(`${OVERLAY}[data-prompt]`)).toBeAttached();
    await expect(page.getByRole("button", { name: "Open your invitation" })).toBeVisible();
    await page.screenshot({ path: resolve(SHOTS, "02-prompt.png") });
  });

  await flow.step(
    "tap: one haptic and the split; a second tap lands it within 1000 ms",
    async () => {
      await page.evaluate(() => {
        const calls: unknown[] = [];
        const vibrate = navigator.vibrate.bind(navigator);
        (navigator as { vibrate: (pattern: VibratePattern) => boolean }).vibrate = (pattern) => {
          calls.push(pattern);
          return vibrate(pattern);
        };
        (window as unknown as { vibrations: unknown[] }).vibrations = calls;
        // Reads the canvas in the task that drew the last frame, before it is
        // presented and cleared.
        new MutationObserver((_records, observer) => {
          if (document.documentElement.getAttribute("data-envelope") !== "open") return;
          observer.disconnect();
          const canvas = document.querySelector<HTMLCanvasElement>(
            "[data-envelope-overlay] canvas",
          );
          (window as unknown as { lastFrame: string }).lastFrame =
            canvas?.toDataURL("image/png") ?? "";
        }).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-envelope"],
        });
      });
      await pauseClock(page);
      await page.locator(`${OVERLAY} button`).tap();
      flow.check(
        "the first tap fires one haptic",
        1,
        await page.evaluate(
          () => (window as unknown as { vibrations: unknown[] }).vibrations.length,
        ),
      );
      await page.clock.runFor(250);
      flow.check("split: the seal breaks", "breaking", (await envelopeState(page)).phase ?? "none");
      await page.screenshot({ path: resolve(SHOTS, "03-split.png") });
      await page.locator(`${OVERLAY} button`).tap();
      await page.clock.runFor(750);
      flow.check(
        "two taps land within 1000 ms of page time",
        "open",
        (await envelopeState(page)).state ?? "none",
      );
      flow.check(
        "only the first tap fires a haptic",
        1,
        await page.evaluate(
          () => (window as unknown as { vibrations: unknown[] }).vibrations.length,
        ),
      );
      await expect(page.locator(OVERLAY)).toHaveCount(0);
      await page.clock.resume();
      await expect(page.getByLabel("Invitation code")).toBeAttached();
      const shot = (await page.screenshot({ path: resolve(SHOTS, "04-landed.png") })).toString(
        "base64",
      );
      const share = await page.evaluate(
        async (input) => {
          const lastFrame = (window as unknown as { lastFrame: string }).lastFrame;
          const decode = async (base64: string) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            return createImageBitmap(new Blob([bytes], { type: "image/png" }));
          };
          if (!lastFrame) return 1;
          const [frame, shown] = await Promise.all([
            decode(lastFrame.split(",")[1]!),
            decode(input.shot),
          ]);
          // The drawing buffer is the CSS size times the pixel ratio rounded down
          // (1081 for 412 x 2.625), the screenshot rounded up (1082); the
          // compositor stretches the one over the other, and so does this.
          const pixels = (bitmap: ImageBitmap) => {
            const canvas = new OffscreenCanvas(shown.width, shown.height);
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(bitmap, 0, 0, shown.width, shown.height);
            return ctx.getImageData(0, 0, shown.width, shown.height).data;
          };
          const a = pixels(frame);
          const b = pixels(shown);
          let differing = 0;
          for (let i = 0; i < a.length; i += 4) {
            const d = Math.max(
              Math.abs(a[i]! - b[i]!),
              Math.abs(a[i + 1]! - b[i + 1]!),
              Math.abs(a[i + 2]! - b[i + 2]!),
            );
            if (d > 16) differing++;
          }
          return differing / (a.length / 4);
        },
        { shot },
      );
      flow.check("the last frame matches the hero beneath it", true, share < HANDOVER_TOLERANCE);
    },
  );

  await flow.step("a reload goes straight to the hero; the footer button replays it", async () => {
    await page.goto(`${INVITE}&envelope-break=peel`);
    await expect(page.getByLabel("Invitation code")).toBeAttached();
    const state = await envelopeState(page);
    flow.check("seen: no envelope on reload", "none", state.state ?? "none");
    flow.check("seen: no overlay on reload", false, state.overlay);
    flow.check("seen: the flag says it played", "1", state.seen ?? "none");
    const replay = page.getByRole("button", { name: "Open the envelope again" });
    await replay.click();
    await waitForState(page, "ready");
    await playOpening(flow, page, { style: "peel", how: "tap", midMs: 300, shot: "05-peel.png" });

    await page.goto(`${INVITE}&envelope-break=crumble`);
    await replay.click();
    await waitForState(page, "ready");
    await expect(page.locator(`${OVERLAY} button`)).toBeFocused();
    await playOpening(flow, page, {
      style: "crumble",
      how: "enter",
      midMs: 250,
      shot: "06-crumble.png",
    });
  });

  await flow.step("an envelope over a hero with no image opens without one", async () => {
    await page.goto(`${PLAIN}&envelope-break=split`);
    await waitForState(page, "ready");
    flow.check(
      "plain: the hero says it has no image",
      "none",
      await page.evaluate(
        () =>
          document.querySelector("[data-edge-hero]")?.getAttribute("data-hero-backdrop") ??
          "missing",
      ),
    );
    await playOpening(flow, page, { style: "split", how: "tap", midMs: 250, shot: "07-plain.png" });
    flow.check("the main context logged no console errors", "none", errors.join(" | ") || "none");
  });

  await flow.step(
    "reduced motion, and a browser without the API, get the page as it is",
    async () => {
      for (const [name, setup] of [
        [
          "reduced motion",
          (b: typeof browser) => newPhonePage(flow, b, { reducedMotion: "reduce" }),
        ],
        [
          "no HTML-in-Canvas",
          async (b: typeof browser) => {
            const opened = await newPhonePage(flow, b);
            await opened.context.addInitScript(NO_HTML_IN_CANVAS);
            return opened;
          },
        ],
      ] as const) {
        const opened = await setup(browser);
        await opened.page.goto(INVITE);
        await expect(opened.page.getByLabel("Invitation code")).toBeAttached();
        const state = await envelopeState(opened.page);
        flow.check(`${name}: not capable`, false, state.capable);
        flow.check(`${name}: not sealed`, "none", state.state ?? "none");
        flow.check(`${name}: no overlay`, false, state.overlay);
        await expect(
          opened.page.getByRole("button", { name: "Open the envelope again" }),
        ).toBeHidden();
        flow.check(`${name}: no console errors`, "none", opened.errors.join(" | ") || "none");
        await opened.context.close();
      }
    },
  );

  await flow.step(
    "a refused scene module, and a lost WebGL context, fall back to the page",
    async () => {
      const refused = await newPhonePage(flow, browser);
      await refused.page.route("**/cire/envelope/src/scene.ts*", (route) => route.abort());
      await refused.page.goto(INVITE);
      await waitForState(refused.page, null);
      const after = await envelopeState(refused.page);
      flow.check("refused: no overlay", false, after.overlay);
      flow.check("refused: the flag says it failed", "failed", after.seen ?? "none");
      await expect(refused.page.getByLabel("Invitation code")).toBeAttached();
      flow.check(
        "refused: the only console error is the refused module",
        "none",
        refused.errors.filter((e) => !e.includes("net::ERR_FAILED")).join(" | ") || "none",
      );
      await refused.context.close();

      const lost = await newPhonePage(flow, browser);
      await lost.page.goto(INVITE);
      await waitForState(lost.page, "ready");
      await rejectConsent(lost.page);
      await expect(lost.page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
      await lost.page.locator(`${OVERLAY} button`).tap();
      await lost.page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-envelope-overlay] canvas");
        canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      });
      await waitForState(lost.page, null);
      const gone = await envelopeState(lost.page);
      flow.check("context lost: no overlay", false, gone.overlay);
      flow.check("context lost: the flag says it failed", "failed", gone.seen ?? "none");
      await lost.context.close();
    },
  );

  await flow.step(
    "a consent prompt that never mounts does not hold the envelope shut",
    async () => {
      const opened = await newPhonePage(flow, browser);
      await opened.page.route("**/src/components/consent/ConsentBanner.tsx*", (route) =>
        route.abort(),
      );
      await opened.page.goto(INVITE);
      await waitForState(opened.page, "ready");
      flow.check(
        "no prompt: not armed at first",
        false,
        (await opened.page.locator(`${OVERLAY}[data-armed]`).count()) > 0,
      );
      await opened.page.clock.runFor(8000);
      await expect(opened.page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
      flow.check(
        "no prompt: armed after 8 s",
        true,
        (await opened.page.locator(`${OVERLAY}[data-armed]`).count()) > 0,
      );
      await opened.context.close();
    },
  );

  await flow.step("a wedding with no envelope draws none", async () => {
    await page.goto(NO_ENVELOPE);
    await expect(page.getByLabel("Invitation code")).toBeAttached();
    const state = await envelopeState(page);
    flow.check(
      "no envelope: the hero is shown",
      true,
      await page.locator("section[data-edge-hero]").isVisible(),
    );
    flow.check("no envelope: the browser is capable", true, state.capable);
    flow.check("no envelope: no key", "none", state.key ?? "none");
    flow.check("no envelope: not sealed", "none", state.state ?? "none");
    flow.check("no envelope: no overlay", false, state.overlay);
    await expect(page.getByRole("button", { name: "Open the envelope again" })).toBeHidden();
    await page.screenshot({ path: resolve(SHOTS, "08-no-envelope.png") });
  });
});
