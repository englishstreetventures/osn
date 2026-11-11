/**
 * Cire: the envelope opening on the guest invite (`@cire/envelope`).
 *
 * The seeded envelope wedding (`CIRE_ORGANISER.envelope`, on Crimson with the
 * Wax seal over a hero with a cropped image) opens as a guest on a Pixel 7
 * profile, in Chromium with HTML-in-Canvas switched on
 * (`--enable-blink-features=CanvasDrawElement`; production Chrome gets it
 * through an origin trial token). The flow:
 *
 * 1. warms `astro dev`'s compile of the scene modules, so the first real
 *    opening is not racing the boot script's 3 s readiness watchdog on a cold
 *    dev server;
 * 2. opens the invite: sealed, covered, the hero image downloaded once,
 *    waiting behind the consent prompt and ignoring a tap until it is
 *    answered, then armed, with focus on its button and kept there;
 * 3. waits for the idle prompt words;
 * 4. changes the viewport while sealed, then taps with the page clock paused:
 *    one haptic, the split break; a second tap speeds it up and it lands
 *    within 1000 ms of page time, on a last frame that matches the hero
 *    underneath, with focus moved to the hero;
 * 5. reloads to no envelope, the hero's crop layer for a phone showing and
 *    the one for a desk at a desk's width, each fading on 0.7s; and replays
 *    from the footer button with the peel (a tap) and the crumble (Enter, its
 *    focus ring showing);
 * 6. opens an envelope over a hero with no image, in the gala pack;
 * 7. checks reduced motion and a browser without the API get the page as it
 *    is, with no attribute and no overlay;
 * 8. checks the page as it is after each failure: the scene module refused, a
 *    scene module or a first paint that comes after the readiness watchdog
 *    (and a replay's), the opening's 6 s deadline, and the WebGL context lost
 *    mid-opening; and that a consent prompt that never mounts still lets the
 *    envelope open after 8 s;
 * 9. opens over a hero image that fails, and over one that never arrives;
 * 10. checks a wedding with a shown hero and no envelope: capable, no key,
 *     nothing drawn.
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
/** The envelope wedding's hero image, every variant. */
const HERO_IMAGE = `**/api/invite/${CIRE_ORGANISER.envelope.slug}/image/hero*`;
/** The scene's entry module as `astro dev` serves it. */
const SCENE_MODULE = "**/cire/envelope/src/scene.ts*";
const PHONE = devices["Pixel 7"];
const OVERLAY = "[data-envelope-overlay]";
const SEEN_PREFIX = "cire:envelope:";
/** At most this share of the frame's pixels may differ by more than 16 of 255 in any channel. */
const HANDOVER_TOLERANCE = 0.005;
/** `BACKDROP_WAIT_MS` in `@cire/envelope/hero`: how long the opening waits for the hero's backdrop. */
const BACKDROP_WAIT_MS = 1500;

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
      design: root.getAttribute("data-design"),
      backdrop:
        document.querySelector("[data-edge-hero]")?.getAttribute("data-hero-backdrop") ?? null,
      overlay: overlay !== null,
      phase: overlay?.dataset["phase"] ?? null,
      breakStyle: overlay?.getAttribute("data-envelope-break") ?? null,
      seen:
        flags.length === 1 ? localStorage.getItem(flags[0]!) : flags.length === 0 ? null : "many",
    };
  }, SEEN_PREFIX);
}

/** Whether keyboard focus is on the hero, the top of the page. */
async function focusOnHero(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.matches("[data-edge-hero]") ?? false);
}

/**
 * The hero's crop layers the viewport lays out, each as its breakpoint
 * (`narrow` below `md:`, `wide` from it) and the fade it runs. On an envelope
 * page each layer is an anonymous-CORS `<img>`, hidden from assistive tech;
 * the backdrop `<img>` beside them is not.
 */
async function shownCropLayers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('img[aria-hidden="true"].object-cover')]
      .filter((img) => getComputedStyle(img).display !== "none")
      .map((img) => {
        const style = getComputedStyle(img);
        const breakpoint = img.classList.contains("md:hidden") ? "narrow" : "wide";
        return `${breakpoint} ${style.transitionProperty} ${style.transitionDuration}`;
      }),
  );
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

/**
 * Counts the hero image's downloads in `page`: responses whose body came over
 * the network, not from the memory or disk cache.
 */
async function countHeroDownloads(context: BrowserContext, page: Page): Promise<() => number> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const hero = new Set<string>();
  let downloads = 0;
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.url.includes(`/api/invite/${CIRE_ORGANISER.envelope.slug}/image/hero`)) {
      hero.add(event.requestId);
    }
  });
  cdp.on("Network.loadingFinished", (event) => {
    if (hero.has(event.requestId) && event.encodedDataLength > 0) downloads++;
  });
  return () => downloads;
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

/**
 * Stops the page clock one frame on from where it is, so frames and timers
 * advance only through `runFor`, however long each call takes to reach the
 * page. `pauseAt` takes an absolute time and refuses one the running clock has
 * passed, and a time read from the page is already behind by the trip back.
 * So `setFixedTime` first stops `Date` at the page clock's own reading, with no
 * such check; `pauseAt` then stops the timers 16 ms past that frozen time,
 * which cannot have passed; and `setSystemTime` lets `Date` move again with
 * `runFor`, which a fixed time would not. A paused clock reads the same
 * `performance.now()` either side of that last call; a clock still running
 * moves it by each whole millisecond that passes, so a pause that does not
 * hold fails the flow within its first few calls.
 */
async function pauseClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(now);
  await page.clock.pauseAt(now + 16);
  const paused = await page.evaluate(() => performance.now());
  await page.clock.setSystemTime(now + 16);
  expect(
    await page.evaluate(() => performance.now()),
    "the page clock holds still once paused",
  ).toBe(paused);
}

/**
 * Reads the canvas in the task that draws the last frame, before it is
 * presented and cleared, into `window.lastFrame`.
 */
async function captureLastFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    new MutationObserver((_records, observer) => {
      if (document.documentElement.getAttribute("data-envelope") !== "open") return;
      observer.disconnect();
      const canvas = document.querySelector<HTMLCanvasElement>("[data-envelope-overlay] canvas");
      (window as unknown as { lastFrame: string }).lastFrame = canvas?.toDataURL("image/png") ?? "";
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-envelope"] });
  });
}

/**
 * The share of pixels that differ by more than 16 of 255 between the captured
 * last frame and `shot`, a screenshot of the page after the hand-over; 1 when
 * no frame was captured.
 */
async function handoverMismatch(page: Page, shot: Buffer): Promise<number> {
  return page.evaluate(
    async (input) => {
      const lastFrame = (window as unknown as { lastFrame?: string }).lastFrame;
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
    { shot: shot.toString("base64") },
  );
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
  const mid = await envelopeState(page);
  flow.check(`${input.style}: the seal breaks`, "breaking", mid.phase ?? "none");
  flow.check(
    `${input.style}: the scene draws the ${input.style} break`,
    input.style,
    mid.breakStyle ?? "none",
  );
  if (input.how === "enter") {
    flow.check(
      `${input.style}: the button keeps its focus ring while it takes keys`,
      true,
      await page.evaluate(() => {
        const button = document.querySelector("[data-envelope-overlay] button");
        return (
          button !== null &&
          button === document.activeElement &&
          button.matches(":focus-visible") &&
          getComputedStyle(button).outlineStyle === "solid"
        );
      }),
    );
  }
  await page.screenshot({ path: resolve(SHOTS, input.shot) });
  await page.clock.runFor(3000 - input.midMs);
  flow.check(
    `${input.style}: lands within 3000 ms at rate 1`,
    "open",
    (await envelopeState(page)).state ?? "none",
  );
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  flow.check(`${input.style}: focus moves to the top of the page`, true, await focusOnHero(page));
  await page.clock.resume();
}

async function newPhonePage(
  flow: Flow,
  browser: import("@playwright/test").Browser,
  options: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {},
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ ...PHONE, ...options });
  await context.addInitScript(HIDE_DEV_TOOLBAR);
  const page = await flow.newPage(context);
  return { context, page, errors: consoleErrors(page) };
}

/**
 * Holds every request matching `glob` in `page` until `release()`; `url` is
 * the last one held. Routing turns off the page's HTTP cache, so no context
 * that counts downloads uses it.
 */
async function holdRequests(page: Page, glob: string) {
  let release: () => void = () => {};
  let held = Promise.resolve();
  const hold = {
    url: "",
    /** Holds the requests that arrive from now on. */
    arm() {
      held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      hold.url = "";
    },
    release: () => release(),
  };
  hold.arm();
  await page.route(glob, async (route) => {
    hold.url = route.request().url();
    await held;
    await route.continue();
  });
  return hold;
}

/**
 * Lets a held scene module load, then gives the mount script its turn: the
 * page imports the module itself, which resolves after the mount's own import
 * of it, and runs one frame of page time.
 */
async function finishHeldModule(page: Page, url: string): Promise<void> {
  await page.evaluate(async (moduleUrl) => {
    await import(moduleUrl);
    return true;
  }, url);
  await page.clock.runFor(100);
}

test("cire-invite-envelope", async ({ page, context, browser, flow }) => {
  // Many contexts and four openings, on SwiftShader in CI: three times the
  // suite's per-flow limit.
  test.slow();
  mkdirSync(SHOTS, { recursive: true });
  await context.addInitScript(HIDE_DEV_TOOLBAR);
  const errors = consoleErrors(page);
  const heroDownloads = await countHeroDownloads(context, page);

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
    flow.check("the envelope wedding renders the classic pack", "classic", state.design ?? "none");
    flow.check("the hero's image loaded", "loaded", state.backdrop ?? "none");
    // The preload, the backdrop and its crop layers, and the card's copy.
    flow.check("the hero image is downloaded once", 1, heroDownloads());
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
    await page.keyboard.press("Tab");
    flow.check(
      "Tab never lands on the page under the cover",
      false,
      await page.evaluate(
        () => document.activeElement?.closest("body > :not([data-envelope-overlay])") != null,
      ),
    );
    // What the inert page leaves focusable outside the overlay: a control
    // outside `<body>`'s children, as a browser extension adds one.
    flow.check(
      "focus that lands outside the page comes back to the overlay",
      true,
      await page.evaluate(() => {
        const stray = document.createElement("button");
        document.documentElement.append(stray);
        stray.focus({ preventScroll: true });
        const back = document.activeElement?.closest("[data-envelope-overlay]") != null;
        stray.remove();
        return back;
      }),
    );
    flow.check("the page under the cover stays at the top", 0, await page.evaluate(() => scrollY));
  });

  await flow.step("the prompt words appear when the guest waits", async () => {
    await expect(page.locator(`${OVERLAY}[data-prompt]`)).toBeAttached();
    await expect(page.getByRole("button", { name: "Open your invitation" })).toBeVisible();
    await page.screenshot({ path: resolve(SHOTS, "02-prompt.png") });
  });

  await flow.step(
    "a viewport change while sealed; then a tap, one haptic and the split; a second tap lands it within 1000 ms",
    async () => {
      // Android's address bar showing: a shorter viewport the scene rebuilds for.
      await page.setViewportSize({ width: 412, height: 780 });
      const rebuilt = () =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            "[data-envelope-overlay] canvas",
          );
          return innerHeight === 780 && canvas?.height === Math.floor(780 * devicePixelRatio);
        });
      await expect.poll(rebuilt).toBe(true);
      flow.check("the scene's drawing buffer follows the new viewport", true, await rebuilt());
      flow.check(
        "still sealed after the change",
        "sealed",
        (await envelopeState(page)).phase ?? "none",
      );
      await page.evaluate(() => {
        const calls: unknown[] = [];
        const vibrate = navigator.vibrate.bind(navigator);
        (navigator as { vibrate: (pattern: VibratePattern) => boolean }).vibrate = (pattern) => {
          calls.push(pattern);
          return vibrate(pattern);
        };
        (window as unknown as { vibrations: unknown[] }).vibrations = calls;
      });
      await captureLastFrame(page);
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
      const mid = await envelopeState(page);
      flow.check("split: the seal breaks", "breaking", mid.phase ?? "none");
      flow.check("split: the scene draws the split break", "split", mid.breakStyle ?? "none");
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
      flow.check("focus moves to the top of the page", true, await focusOnHero(page));
      await page.clock.resume();
      await expect(page.getByLabel("Invitation code")).toBeAttached();
      const shot = await page.screenshot({ path: resolve(SHOTS, "04-landed.png") });
      flow.check(
        "the last frame matches the hero beneath it, at the new size",
        true,
        (await handoverMismatch(page, shot)) < HANDOVER_TOLERANCE,
      );
      await page.setViewportSize(PHONE.viewport);
    },
  );

  await flow.step("a reload goes straight to the hero; the footer button replays it", async () => {
    await page.goto(`${INVITE}&envelope-break=peel`);
    await expect(page.getByLabel("Invitation code")).toBeAttached();
    const state = await envelopeState(page);
    flow.check("seen: no envelope on reload", "none", state.state ?? "none");
    flow.check("seen: no overlay on reload", false, state.overlay);
    flow.check("seen: the flag says it played", "1", state.seen ?? "none");
    // One crop layer per breakpoint, and only one laid out at a width.
    flow.check(
      "a phone shows the narrow crop layer, fading on 0.7s",
      "narrow opacity 0.7s",
      (await shownCropLayers(page)).join(" | ") || "none",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    flow.check(
      "a desk shows the wide crop layer, fading on 0.7s",
      "wide opacity 0.7s",
      (await shownCropLayers(page)).join(" | ") || "none",
    );
    await page.setViewportSize(PHONE.viewport);
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

  await flow.step(
    "an envelope over a hero with no image opens without one, in the gala pack",
    async () => {
      await page.goto(`${PLAIN}&envelope-break=split`);
      await waitForState(page, "ready");
      const state = await envelopeState(page);
      flow.check("plain: the page renders the gala pack", "gala", state.design ?? "none");
      flow.check("plain: the hero says it has no image", "none", state.backdrop ?? "missing");
      await playOpening(flow, page, {
        style: "split",
        how: "tap",
        midMs: 250,
        shot: "07-plain.png",
      });
      flow.check("the main context logged no console errors", "none", errors.join(" | ") || "none");
    },
  );

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
      await refused.page.route(SCENE_MODULE, (route) => route.abort());
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
    "a scene module that arrives after the watchdog is thrown away, and so is a replay's",
    async () => {
      const slow = await newPhonePage(flow, browser);
      const held = await holdRequests(slow.page, SCENE_MODULE);
      // Every timer from here runs on `runFor`, so the watchdog fires when the
      // flow says and not when a slow runner happens to reach it.
      await pauseClock(slow.page);
      // A held module keeps the document's `load` from firing.
      await slow.page.goto(INVITE, { waitUntil: "commit" });
      await waitForState(slow.page, "sealed");
      await expect.poll(() => held.url).not.toBe("");
      await expect(slow.page.getByLabel("Invitation code")).toBeAttached();
      flow.check(
        "held: the page under the cover is inert from the first paint",
        "inert",
        await slow.page.evaluate(() =>
          getComputedStyle(document.querySelector("[data-edge-hero]")!).getPropertyValue(
            "interactivity",
          ),
        ),
      );
      await slow.page.getByLabel("Invitation code").focus();
      flow.check(
        "held: the code field under the cover cannot take focus",
        false,
        await slow.page.evaluate(() => document.activeElement?.matches("input") ?? false),
      );
      await slow.page.clock.runFor(3000);
      await waitForState(slow.page, null);
      flow.check(
        "held: the flag says it failed",
        "failed",
        (await envelopeState(slow.page)).seen ?? "none",
      );
      held.release();
      await finishHeldModule(slow.page, held.url);
      flow.check(
        "held: the late scene draws nothing",
        false,
        (await envelopeState(slow.page)).overlay,
      );

      // The flag says `failed`, so the page loads unsealed; the replay waits
      // on a module held the same way and gives up on its own watchdog. The
      // guest answers the consent prompt first, which hydrates when the
      // browser is idle, on page time; until it is answered it holds focus.
      held.arm();
      await slow.page.goto(INVITE, { waitUntil: "commit" });
      await slow.page.clock.resume();
      await rejectConsent(slow.page);
      await pauseClock(slow.page);
      await slow.page.getByRole("button", { name: "Open the envelope again" }).click();
      await waitForState(slow.page, "sealed");
      await expect.poll(() => held.url).not.toBe("");
      await slow.page.clock.runFor(3000);
      await waitForState(slow.page, null);
      const replayed = await envelopeState(slow.page);
      flow.check("held replay: no overlay", false, replayed.overlay);
      flow.check("held replay: the flag says it failed", "failed", replayed.seen ?? "none");
      flow.check(
        "held replay: focus moves to the top of the page",
        true,
        await focusOnHero(slow.page),
      );
      held.release();
      await finishHeldModule(slow.page, held.url);
      flow.check(
        "held replay: the late scene draws nothing",
        false,
        (await envelopeState(slow.page)).overlay,
      );
      await slow.context.close();
    },
  );

  await flow.step(
    "a scene whose first paint never comes is disposed when the watchdog fires",
    async () => {
      const unpainted = await newPhonePage(flow, browser);
      // The API is still there for the boot script, but the scene's paint
      // handler is dropped, so the card's first upload never comes.
      await unpainted.context.addInitScript(
        'Object.defineProperty(HTMLCanvasElement.prototype, "onpaint", { configurable: true, get() { return null; }, set() {} });',
      );
      await pauseClock(unpainted.page);
      await unpainted.page.goto(INVITE, { waitUntil: "commit" });
      await expect(unpainted.page.locator(OVERLAY)).toBeAttached();
      await unpainted.page.clock.runFor(3000);
      await waitForState(unpainted.page, null);
      await expect(unpainted.page.locator(OVERLAY)).toHaveCount(0);
      flow.check(
        "unpainted: the flag says it failed",
        "failed",
        (await envelopeState(unpainted.page)).seen ?? "none",
      );
      // A scene disposed mid-set-up ends the opening, so the replay answers.
      // The consent prompt, open by now, is answered first.
      await unpainted.page.clock.resume();
      await rejectConsent(unpainted.page);
      await pauseClock(unpainted.page);
      await unpainted.page.getByRole("button", { name: "Open the envelope again" }).click();
      flow.check(
        "unpainted: the replay button still answers",
        "sealed",
        (await envelopeState(unpainted.page)).state ?? "none",
      );
      await unpainted.page.clock.runFor(3000);
      await waitForState(unpainted.page, null);
      await expect(unpainted.page.locator(OVERLAY)).toHaveCount(0);
      await unpainted.context.close();
    },
  );

  await flow.step("an opening that does not land within 6 s gives the page back", async () => {
    const stalled = await newPhonePage(flow, browser);
    await stalled.page.goto(INVITE);
    await waitForState(stalled.page, "ready");
    await rejectConsent(stalled.page);
    await expect(stalled.page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
    await pauseClock(stalled.page);
    // No frame ever comes, so only the deadline can end the opening.
    await stalled.page.evaluate(() => {
      window.requestAnimationFrame = () => 0;
    });
    await stalled.page.locator(`${OVERLAY} button`).tap();
    await stalled.page.clock.runFor(6000);
    await waitForState(stalled.page, null);
    const after = await envelopeState(stalled.page);
    flow.check("deadline: no overlay", false, after.overlay);
    flow.check("deadline: the flag says it failed", "failed", after.seen ?? "none");
    flow.check(
      "deadline: focus moves to the top of the page",
      true,
      await focusOnHero(stalled.page),
    );
    await stalled.context.close();
  });

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

  await flow.step("a hero image that fails to load: the envelope opens without it", async () => {
    const broken = await newPhonePage(flow, browser);
    await broken.page.route(HERO_IMAGE, (route) =>
      route.fulfill({
        status: 404,
        headers: { "access-control-allow-origin": ORIGINS.cireInvites, vary: "Accept, Origin" },
        body: "",
      }),
    );
    await broken.page.goto(`${INVITE}&envelope-break=split`);
    await waitForState(broken.page, "ready");
    flow.check(
      "failed image: the hero says its image failed",
      "error",
      (await envelopeState(broken.page)).backdrop ?? "none",
    );
    await rejectConsent(broken.page);
    await expect(broken.page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
    await captureLastFrame(broken.page);
    await pauseClock(broken.page);
    await broken.page.locator(`${OVERLAY} button`).tap();
    await broken.page.clock.runFor(3000);
    flow.check("failed image: lands", "open", (await envelopeState(broken.page)).state ?? "none");
    await expect(broken.page.locator(OVERLAY)).toHaveCount(0);
    await broken.page.clock.resume();
    const shot = await broken.page.screenshot({ path: resolve(SHOTS, "09-failed-image.png") });
    flow.check(
      "failed image: the last frame matches the hero beneath it",
      true,
      (await handoverMismatch(broken.page, shot)) < HANDOVER_TOLERANCE,
    );
    flow.check(
      "failed image: the flag says it played",
      "1",
      (await envelopeState(broken.page)).seen ?? "none",
    );
    flow.check(
      "failed image: the only console errors are the image's",
      "none",
      broken.errors.filter((e) => !e.includes("404")).join(" | ") || "none",
    );
    await broken.context.close();
  });

  await flow.step(
    "a hero image that never arrives: the envelope stops waiting and opens without it",
    async () => {
      const waiting = await newPhonePage(flow, browser);
      const image = await holdRequests(waiting.page, HERO_IMAGE);
      await pauseClock(waiting.page);
      const sceneRequested = waiting.page.waitForRequest(SCENE_MODULE);
      // A held image keeps the document's `load` from firing.
      await waiting.page.goto(`${INVITE}&envelope-break=split`, { waitUntil: "commit" });
      // The mount asks for the scene in the same turn as it starts waiting on
      // the backdrop, so the wait's timer is set by now.
      await sceneRequested;
      await waitForState(waiting.page, "sealed");
      await waiting.page.clock.runFor(BACKDROP_WAIT_MS);
      await waitForState(waiting.page, "ready");
      flow.check(
        "held image: the hero is still waiting for it",
        "pending",
        (await envelopeState(waiting.page)).backdrop ?? "none",
      );
      // The consent banner hydrates when the browser is idle, on page time.
      await waiting.page.clock.resume();
      await rejectConsent(waiting.page);
      await expect(waiting.page.locator(`${OVERLAY}[data-armed]`)).toBeAttached();
      await captureLastFrame(waiting.page);
      await pauseClock(waiting.page);
      await waiting.page.locator(`${OVERLAY} button`).tap();
      await waiting.page.clock.runFor(3000);
      flow.check("held image: lands", "open", (await envelopeState(waiting.page)).state ?? "none");
      await expect(waiting.page.locator(OVERLAY)).toHaveCount(0);
      await waiting.page.clock.resume();
      const shot = await waiting.page.screenshot({ path: resolve(SHOTS, "10-held-image.png") });
      flow.check(
        "held image: the last frame matches the hero beneath it",
        true,
        (await handoverMismatch(waiting.page, shot)) < HANDOVER_TOLERANCE,
      );
      flow.check(
        "held image: the flag says it played",
        "1",
        (await envelopeState(waiting.page)).seen ?? "none",
      );
      image.release();
      await waiting.context.close();
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
    flow.check("no envelope: the page renders the classic pack", "classic", state.design ?? "none");
    flow.check("no envelope: the hero says it has no image", "none", state.backdrop ?? "missing");
    flow.check("no envelope: the browser is capable", true, state.capable);
    flow.check("no envelope: no key", "none", state.key ?? "none");
    flow.check("no envelope: not sealed", "none", state.state ?? "none");
    flow.check("no envelope: no overlay", false, state.overlay);
    await expect(page.getByRole("button", { name: "Open the envelope again" })).toBeHidden();
    await page.screenshot({ path: resolve(SHOTS, "08-no-envelope.png") });
  });
});
