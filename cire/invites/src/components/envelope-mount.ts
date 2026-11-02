/**
 * Plays the envelope opening on the invite, once the boot script in `<head>`
 * has sealed the page (`@cire/envelope/boot`), and wires the replay button.
 * Called once from each design pack's `Document.astro` module script.
 *
 * It owns the `<html>` side of the opening:
 *
 * - It loads the scene (`@cire/envelope/scene`, with `three`) only for a page
 *   the boot script sealed, so no other guest downloads it. While the chunk
 *   downloads it readies the card's inputs (`@cire/envelope/hero`): the
 *   hero's image copied to a `blob:` URL, which it owns and revokes, and the
 *   display font.
 * - It reveals the scene and sets `data-envelope="ready"` only while the page
 *   is still `sealed`. Once the boot watchdog has given up, a late scene is
 *   thrown away unseen.
 * - Consent first: taps do nothing, and the idle prompt does not start, until
 *   the consent prompt has been answered. The consent store is loaded beside
 *   the scene, so a page that never seals loads it only when the banner does. If no answer is on record 8 s after
 *   the reveal and no dialog is open, the consent prompt never mounted, and
 *   the envelope accepts taps rather than strand the guest behind it.
 * - On landing it sets `open`, writes the seen flag, and lets the overlay go.
 * - Any failure removes the attribute, so the page is the page without an
 *   envelope, and writes the seen flag as `failed`, so this device does not
 *   pay for the attempt again.
 *
 * There is no client error reporting on the guest site, so a failure is
 * silent: the guest sees the invite as it is without an envelope.
 */

import { pickBreak } from "@cire/envelope";
import {
  ENVELOPE_ATTR,
  ENVELOPE_KEY_ATTR,
  ENVELOPE_REPLAY_ATTR,
  ENVELOPE_WATCHDOG_MS,
  writeSeen,
} from "@cire/envelope/boot";
import { prepareCard } from "@cire/envelope/hero";
import { createEffect, createRoot } from "solid-js";

import { EDGE_HERO_ATTR } from "./edge-boot";

/** The two parts of the consent store the envelope reads. */
type ConsentReader = Pick<
  typeof import("../lib/consent/store"),
  "consentRecord" | "hydrateConsent"
>;

/** How long after the reveal the envelope stops waiting for a consent answer that never came. */
const CONSENT_FALLBACK_MS = 8000;

/** The hero section the card is drawn from, as the page has it now. */
const findHero = (doc: Document) => () => doc.querySelector<HTMLElement>(`[${EDGE_HERO_ATTR}]`);

/** The break style for this opening: `?envelope-break=` names one, otherwise one at random. */
function breakStyle(win: Window) {
  return pickBreak(new URLSearchParams(win.location.search), (array) => {
    // `pickBreak` passes a fresh `Uint32Array`, always on an `ArrayBuffer`.
    win.crypto.getRandomValues(array as Uint32Array<ArrayBuffer>);
    return array;
  });
}

let playing = false;

async function play(doc: Document): Promise<void> {
  const win = doc.defaultView;
  const root = doc.documentElement;
  const key = root.getAttribute(ENVELOPE_KEY_ATTR);
  if (!win || !key || playing) return;
  playing = true;
  const sealed = () => root.getAttribute(ENVELOPE_ATTR) === "sealed";
  let dispose: (() => void) | null = null;
  let blobUrl: string | null = null;
  // Thrown away the moment the page stops being sealed before the reveal,
  // whatever the scene is doing then.
  const watch = new MutationObserver(() => {
    if (!sealed()) dispose?.();
  });
  try {
    const hero = findHero(doc)();
    if (!hero) throw new Error("envelope: no hero");
    const [loaded, consent, prepared] = await Promise.allSettled([
      import("@cire/envelope/scene"),
      import("../lib/consent/store"),
      prepareCard(hero),
    ]);
    // Kept before any failure is thrown, so `finally` revokes it.
    if (prepared.status === "fulfilled") blobUrl = prepared.value;
    if (loaded.status === "rejected") throw loaded.reason;
    if (consent.status === "rejected") throw consent.reason;
    if (prepared.status === "rejected") throw prepared.reason;
    if (!sealed()) return;
    const scene = loaded.value.createEnvelopeScene({
      hero: findHero(doc),
      host: doc.body,
      breakStyle: breakStyle(win),
      blobUrl,
    });
    dispose = scene.dispose;
    watch.observe(root, { attributes: true, attributeFilter: [ENVELOPE_ATTR] });
    await scene.ready;
    watch.disconnect();
    if (!sealed()) {
      scene.dispose();
      return;
    }
    scene.reveal();
    root.setAttribute(ENVELOPE_ATTR, "ready");
    armAfterConsent(win, doc, consent.value, scene.arm);
    await scene.landed;
    root.setAttribute(ENVELOPE_ATTR, "open");
    writeSeen(key, "1");
    await scene.leave();
  } catch {
    dispose?.();
    if (root.getAttribute(ENVELOPE_ATTR) !== "open") root.removeAttribute(ENVELOPE_ATTR);
    writeSeen(key, "failed");
  } finally {
    watch.disconnect();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    playing = false;
  }
}

function armAfterConsent(
  win: Window,
  doc: Document,
  { consentRecord, hydrateConsent }: ConsentReader,
  arm: () => void,
): void {
  hydrateConsent();
  createRoot((dispose) => {
    createEffect(() => {
      if (consentRecord() === null) return;
      arm();
      dispose();
    });
  });
  win.setTimeout(() => {
    if (consentRecord() === null && !doc.querySelector("dialog[open]")) arm();
  }, CONSENT_FALLBACK_MS);
}

/**
 * The replay button: go back to the top and play the opening again in place,
 * with a readiness watchdog of its own (the boot script's ran once, at load).
 * The seen flag is left as it is: every replay ends by writing it again, `1`
 * or `failed`, and a guest who leaves mid-replay has seen the envelope.
 */
function replay(doc: Document): void {
  const win = doc.defaultView;
  const root = doc.documentElement;
  const key = root.getAttribute(ENVELOPE_KEY_ATTR);
  const state = root.getAttribute(ENVELOPE_ATTR);
  if (!win || !key || playing || state === "sealed" || state === "ready") return;
  win.scrollTo({ top: 0, left: 0, behavior: "instant" });
  root.setAttribute(ENVELOPE_ATTR, "sealed");
  win.setTimeout(() => {
    if (root.getAttribute(ENVELOPE_ATTR) !== "sealed") return;
    root.removeAttribute(ENVELOPE_ATTR);
    writeSeen(key, "failed");
  }, ENVELOPE_WATCHDOG_MS);
  void play(doc);
}

export function startEnvelope(doc: Document = document): void {
  for (const button of doc.querySelectorAll<HTMLElement>(`[${ENVELOPE_REPLAY_ATTR}]`)) {
    button.addEventListener("click", () => replay(doc));
  }
  if (doc.documentElement.getAttribute(ENVELOPE_ATTR) === "sealed") void play(doc);
}
