/**
 * What the card needs from the page before the scene is built, and nothing
 * that loads `three`: the hero's backdrop settled, its image as a same-origin
 * URL, and the display font loaded. The invite's mount script runs it while
 * the scene module downloads, so the image and the font are not waiting on the
 * chunk, nor on each other.
 */

/**
 * How long the opening waits for the hero's backdrop to settle before it goes
 * on without the photo. The readiness watchdog (3 s from the head script) has
 * to cover this, then the module script, the scene chunk, WebGL set-up and the
 * card's first upload.
 */
export const BACKDROP_WAIT_MS = 1500;

const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/** The value of a custom property on `<html>`, or `fallback`. */
export function cssVar(doc: Document, name: string, fallback: string): string {
  const value = doc.defaultView
    ?.getComputedStyle(doc.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** The family the seal's letter is drawn in: the invite's display face. */
export function displayFont(doc: Document): string {
  return cssVar(doc, "--font-display", "Georgia, serif");
}

/**
 * Resolves `true` once the hero's backdrop has settled, so the clone carries
 * the image at its final opacity: `data-hero-backdrop` is `loaded`, `error`
 * or `none`, or absent. Resolves `false` after `waitMs` without that.
 */
export function backdropSettled(
  hero: HTMLElement,
  win: Window,
  waitMs: number = BACKDROP_WAIT_MS,
): Promise<boolean> {
  const settled = () => {
    const state = hero.getAttribute("data-hero-backdrop");
    return state === null || state === "loaded" || state === "error" || state === "none";
  };
  if (settled()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      observer.disconnect();
      win.clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (settled()) finish(true);
    });
    observer.observe(hero, { attributes: true, attributeFilter: ["data-hero-backdrop"] });
    const timer = win.setTimeout(() => finish(false), waitMs);
  });
}

/**
 * The hero image as a same-origin `blob:` URL, or `null` when the hero shows
 * no image (none set, or it failed to load, which drops it from the hero too).
 * Throws when the image is there but cannot be fetched: a card without the
 * photo would jump at the hand-over, so the opening does not play.
 *
 * Cross-origin pixels never paint into a canvas, and the image is on
 * cire-api's origin, so the card needs a copy it may draw: fetched once more
 * in CORS mode (cire-api allows the invite's origin) and turned into a `blob:`
 * URL, which is same-origin.
 */
export async function heroImageBlobUrl(hero: HTMLElement): Promise<string | null> {
  const img = hero.querySelector("img");
  const src = img?.currentSrc || img?.getAttribute("src");
  if (!src) return null;
  // The `Accept` Chrome sends for an `<img>`, so cire-api negotiates the same
  // format the page's hero got and the card's pixels are the hero's. A
  // CORS-safelisted header: no preflight.
  const response = await fetch(src, {
    mode: "cors",
    credentials: "omit",
    headers: { Accept: IMAGE_ACCEPT },
  });
  if (!response.ok) throw new Error(`envelope: hero image ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

/**
 * Readies the card's inputs together: waits (at most {@link BACKDROP_WAIT_MS})
 * for the backdrop, then copies the image unless the hero shows none or the
 * wait ran out; meanwhile loads the display font. Resolves to the image's
 * `blob:` URL, which the caller owns and revokes, or `null` for a card
 * without the photo.
 */
export async function prepareCard(hero: HTMLElement): Promise<string | null> {
  const doc = hero.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("envelope: no window");
  const image = (async () => {
    if (!(await backdropSettled(hero, win))) return null;
    const state = hero.getAttribute("data-hero-backdrop");
    return state === "error" || state === "none" ? null : heroImageBlobUrl(hero);
  })();
  const font = doc.fonts?.load(`600 100px ${displayFont(doc)}`).catch(() => []);
  const [blobUrl] = await Promise.all([image, font]);
  return blobUrl;
}
