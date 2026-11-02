/**
 * What the invite page needs before first paint, and nothing that loads
 * `three`: the boot script, the head stylesheet, the attribute names the boot
 * script and the scene's mount agree on, and the seen flag.
 *
 * The page's `<html>` carries the whole state, so it can be read before any
 * script module has loaded:
 *
 * - `data-envelope-key`: set by the server, only for a wedding with a catalog
 *   envelope over a shown hero. The SHA-256 of `slug:envelopeId`
 *   ({@link envelopeKey}), so storage never holds the couple's names, and a
 *   new envelope is a new key that every guest sees once.
 * - `data-envelope-capable`: set by the boot script when this browser can draw
 *   the opening (HTML-in-Canvas, WebGL2) and make the page under it inert
 *   (CSS `interactivity`), and the device does not ask for reduced motion.
 *   Whether or not this invite has an envelope.
 * - `data-envelope`: `sealed` from the boot script, `ready` once the scene has
 *   drawn its first frame, `open` once the card has landed. Removed on any
 *   failure. Without it the page is exactly the page without an envelope.
 */

/** `<html>` attribute holding the opening's state: `sealed`, `ready` or `open`. */
export const ENVELOPE_ATTR = "data-envelope";
/** `<html>` attribute the server sets to the envelope's storage key. */
export const ENVELOPE_KEY_ATTR = "data-envelope-key";
/** `<html>` attribute the boot script sets when this browser can play an opening. */
export const ENVELOPE_CAPABLE_ATTR = "data-envelope-capable";
/** Attribute on the replay button(s); the head stylesheet shows them only where an opening can replay. */
export const ENVELOPE_REPLAY_ATTR = "data-envelope-replay";

/** The states `data-envelope` takes, in order. */
export type EnvelopeState = "sealed" | "ready" | "open";

/**
 * How long the scene has, from the boot script, to draw its first frame. Past
 * it the cover is removed and the opening counts as failed on this device, so
 * no guest waits behind a blank cover. A scene that turns up later does
 * nothing.
 */
export const ENVELOPE_WATCHDOG_MS = 3000;

/** The query parameter that plays a stored envelope despite `?code=` or the seen flag. */
export const ENVELOPE_FORCE_PARAM = "envelope";

const SEEN_PREFIX = "cire:envelope:";

/** The `localStorage` key of the seen flag for one envelope key. */
export function seenStorageKey(key: string): string {
  return `${SEEN_PREFIX}${key}`;
}

/** What the seen flag holds: `1` once the opening has played, `failed` when it could not. */
export type SeenValue = "1" | "failed";

type StorageWriter = Pick<Storage, "setItem">;

const defaultStorage = (): StorageWriter => localStorage;

/**
 * Records that this envelope has played (or failed) in this browser. Storage
 * may be disabled, full, or unreachable; any of those leaves the flag unwritten
 * and the guest sees the opening again next time, which is the safe side.
 */
export function writeSeen(
  key: string,
  value: SeenValue,
  storage: () => StorageWriter = defaultStorage,
): void {
  try {
    storage().setItem(seenStorageKey(key), value);
  } catch {
    // Storage unavailable: nothing is remembered, nothing breaks.
  }
}

/**
 * The envelope's storage key for a wedding: the lower-case hex SHA-256 of
 * `slug:envelopeId`. Computed on the server, which renders it as
 * `data-envelope-key`; the browser never sees the pair hashed.
 */
export async function envelopeKey(slug: string, envelopeId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${slug}:${envelopeId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The inline script for `<head>`, after the `<html>` attributes it reads. A
 * constant: the only per-request input is `data-envelope-key`, which the
 * server escapes as an attribute. It seals the page only when all of these
 * hold:
 *
 * - the HTML-in-Canvas API (`requestPaint`, `texElementSubImage2D`) and
 *   WebGL2 exist. Only the constructors are checked; creating a context here
 *   would start the GPU process before first paint;
 * - CSS supports `interactivity: inert`, which the head stylesheet uses to
 *   take the page under the cover out of reach of the keyboard;
 * - the device does not ask for reduced motion;
 * - the server set a key;
 * - the link has no `?code=` (that guest is mid-claim) and the seen flag is
 *   absent, unless `?envelope=1` asks to play it anyway;
 * - reading the seen flag did not throw.
 *
 * Once sealed it starts the readiness watchdog ({@link ENVELOPE_WATCHDOG_MS}).
 * Any throw leaves the page unsealed. `boot.test.ts` runs this string.
 */
export const ENVELOPE_BOOT_SCRIPT = `(function () {
  var root = document.documentElement;
  try {
    if (!("requestPaint" in HTMLCanvasElement.prototype)) return;
    if (typeof WebGL2RenderingContext !== "function") return;
    if (!("texElementSubImage2D" in WebGL2RenderingContext.prototype)) return;
    if (!CSS.supports("interactivity", "inert")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.setAttribute("${ENVELOPE_CAPABLE_ATTR}", "");
    var key = root.getAttribute("${ENVELOPE_KEY_ATTR}");
    if (!key) return;
    var query = new URLSearchParams(location.search);
    if (query.get("${ENVELOPE_FORCE_PARAM}") !== "1") {
      if (query.has("code")) return;
      if (localStorage.getItem("${SEEN_PREFIX}" + key) !== null) return;
    }
    root.setAttribute("${ENVELOPE_ATTR}", "sealed");
    setTimeout(function () {
      if (root.getAttribute("${ENVELOPE_ATTR}") !== "sealed") return;
      root.removeAttribute("${ENVELOPE_ATTR}");
      try {
        localStorage.setItem("${SEEN_PREFIX}" + key, "failed");
      } catch (e) {}
    }, ${ENVELOPE_WATCHDOG_MS});
  } catch (e) {
    root.removeAttribute("${ENVELOPE_ATTR}");
  }
})();`;

/**
 * The head stylesheet, inline beside the boot script so it applies from first
 * paint whatever order the page's own CSS arrives in. `z` is the overlay's
 * layer on the page (`Z_LAYER.ENVELOPE` in cire/invites); a number, so nothing
 * from a request reaches this text.
 *
 * - While `sealed` or `ready`: the page is covered in its own ground colour,
 *   cannot scroll (nor be pulled to refresh), and the hero's animations hold
 *   at their start. So do the animations of the card's clone inside the
 *   overlay, so the two match at the hand-over. `scrollbar-gutter: stable`
 *   keeps the hero's width when scrolling unlocks.
 * - From the first paint the cover is up, every child of `<body>` but the
 *   overlay is inert (`interactivity: inert`), so Tab and a screen reader
 *   cannot reach what the guest cannot see. The child holding an open
 *   `<dialog>` is left alone, so the consent prompt, a modal dialog in its own
 *   island, works as ever.
 * - The overlay (`[data-envelope-overlay]`), built by `./scene`. Its button
 *   takes taps with `touch-action: manipulation`, so the quick second tap
 *   that speeds the opening up is never read as a double-tap zoom, and shows
 *   its focus ring whenever it is focused from the keyboard, in every phase,
 *   since Enter and Space speed the opening up too. It is painted
 *   from the moment it is added, because a drawable canvas child that is not
 *   painted has nothing to upload; before the reveal it looks exactly like the
 *   cover beneath it and takes no taps. It disappears the instant
 *   `data-envelope` is removed, whatever the scene is doing.
 * - The replay button shows only where an opening can replay.
 * - The hero, which takes focus once the opening ends so the next Tab starts
 *   at the top, draws no ring: it is a place to start from, not a control.
 */
export function envelopeStyle(z: number): string {
  const layer = Number.isFinite(z) ? Math.trunc(z) : 0;
  const live = `html[${ENVELOPE_ATTR}]:not([${ENVELOPE_ATTR}="open"])`;
  return [
    `${live}{overflow:hidden;scrollbar-gutter:stable;overscroll-behavior:none}`,
    `${live} body::before{content:"";position:fixed;inset:0;z-index:${layer};background:var(--color-bg,#14261b)}`,
    `${live} [data-edge-hero],${live} [data-edge-hero] *,[data-envelope-overlay] *{animation-play-state:paused!important}`,
    `${live} body>:not([data-envelope-overlay]):not(:has(dialog[open])){interactivity:inert}`,
    `[data-envelope-overlay]{position:fixed;inset:0;z-index:${layer};background:var(--color-bg,#14261b);transition:opacity .2s ease-out}`,
    `[data-envelope-overlay][data-state="loading"]{pointer-events:none}`,
    `html:not([${ENVELOPE_ATTR}]) [data-envelope-overlay]{display:none}`,
    `[data-envelope-overlay][data-state="leaving"]{opacity:0;pointer-events:none}`,
    `[data-envelope-overlay] canvas{position:absolute;inset:0;width:100%;height:100%;display:block}`,
    `[data-envelope-overlay] button{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}`,
    `[data-envelope-overlay] button:focus-visible{outline:2px solid var(--color-gold-ink,#c9a86a);outline-offset:-6px}`,
    `[data-envelope-overlay] button:focus:not(:focus-visible){outline:none}`,
    `[data-edge-hero][tabindex="-1"]:focus{outline:none}`,
    `[data-envelope-overlay] [data-envelope-prompt]{position:absolute;left:0;right:0;bottom:max(2.5rem,calc(env(safe-area-inset-bottom) + 1.5rem));margin:0;text-align:center;font-family:var(--font-body,"Lato",system-ui,sans-serif);font-size:.8125rem;letter-spacing:.2em;text-transform:uppercase;color:var(--color-text-muted,rgba(255,255,255,.6));opacity:0;transition:opacity .6s ease-out;pointer-events:none}`,
    `[data-envelope-overlay][data-prompt] [data-envelope-prompt]{opacity:1}`,
    `[${ENVELOPE_REPLAY_ATTR}]{display:none}`,
    `html[${ENVELOPE_CAPABLE_ATTR}][${ENVELOPE_KEY_ATTR}] [${ENVELOPE_REPLAY_ATTR}]{display:inline-block;margin:1.5rem 0 0;padding:.5rem .75rem;border:0;border-radius:.25rem;background:none;font-family:var(--font-body,"Lato",system-ui,sans-serif);font-size:.8125rem;letter-spacing:.04em;color:var(--color-text-muted,rgba(255,255,255,.6));text-decoration:underline;text-decoration-color:color-mix(in oklab,currentColor 45%,transparent);text-underline-offset:.3em;cursor:pointer}`,
    `[${ENVELOPE_REPLAY_ATTR}]:hover{color:var(--color-text,#fff)}`,
    `[${ENVELOPE_REPLAY_ATTR}]:focus-visible{outline:2px solid var(--color-gold-ink,#c9a86a);outline-offset:2px}`,
  ].join("\n");
}
