import { WebHaptics } from "web-haptics";

import { hapticsEnabled } from "./theme";

/**
 * Touch feedback for the host portal.
 *
 * The portal names the *event*, never the waveform: `commit` is "that landed",
 * `reject` is "that did not", and what either feels like is one table below
 * rather than a duration scattered across thirty call sites.
 *
 * Five names, and deliberately no more. A vocabulary this small is the whole
 * point — haptics stop meaning anything the moment every tap has its own
 * flavour, and a phone in a pocket buzzing through a seating chart is worse
 * than no feedback at all. Module switches, sub-tab switches and card taps are
 * silent by design: they are navigation, and navigation already answers with
 * the screen.
 *
 * Not gated on `prefers-reduced-motion`. That setting is about vestibular
 * discomfort from things moving on screen; some of the same hosts rely on touch
 * feedback precisely *because* they have animation turned off. The host's own
 * switch in the profile menu is the only control.
 *
 * On Android and Chrome this is the Vibration API. On iOS `navigator.vibrate`
 * does not exist, and the library falls back to clicking a hidden
 * `<input type="checkbox" switch>` — Safari 17.4+ plays the system switch
 * haptic for it. Everywhere else the calls are inert. Inside a cross-origin
 * iframe the Vibration API is blocked by permissions policy, so the invite
 * preview pane cannot buzz the phone from a guest-side interaction.
 */

export type Haptic =
  /** A change took: a checklist tick, a saved form, a committed drag, a copy. */
  | "commit"
  /** A change did not take: a rejected save, a failed validation. */
  | "reject"
  /** A drag lifted off. */
  | "pickup"
  /** A drag crossed into the next slot. */
  | "step"
  /** A sheet or modal went away. */
  | "dismiss";

/** Semantic name → the library's preset. The only place a waveform is chosen. */
const PRESET = {
  commit: "success",
  reject: "error",
  pickup: "medium",
  step: "selection",
  dismiss: "soft",
} satisfies Readonly<Record<Haptic, string>>;

let engine: WebHaptics | undefined;

/**
 * The one instance, built on first use.
 *
 * Lazy because the iOS fallback appends a hidden `<label>` to `document.body`,
 * which a module-scope constructor would do during hydration whether or not the
 * host ever triggers anything — and, under SSR or a bare test environment,
 * would do to a document that is not there.
 */
function instance(): WebHaptics | undefined {
  if (typeof document === "undefined") return undefined;
  engine ??= new WebHaptics({ showSwitch: false });
  return engine;
}

/**
 * Whether this build can produce touch feedback at all — which is the question
 * the profile menu's switch is asking, and deliberately *not* the same question
 * as `WebHaptics.isSupported`.
 *
 * `isSupported` is `typeof navigator.vibrate === "function"`, which is false on
 * iOS Safari — the one platform where the switch-element fallback actually
 * plays a system haptic. Gating the control on it would hide the off switch on
 * the only device that buzzes, and show it on desktop Chrome, where
 * `navigator.vibrate` exists and does nothing. So the gate is "there is a
 * document to hang the fallback on", and the library's own guards decide
 * whether anything is delivered.
 */
export function hapticsAvailable(): boolean {
  return typeof document !== "undefined";
}

/**
 * Fire one. Silent when the host has haptics off, when there is no document,
 * and — by the library's own guards — when the platform cannot deliver it.
 *
 * Deliberately fire-and-forget: `trigger()` resolves when the *pattern* has
 * finished playing, which is up to a couple of hundred milliseconds later, and
 * no caller should be waiting on that before updating the screen.
 */
export function haptic(name: Haptic): void {
  if (!hapticsEnabled()) return;
  const device = instance();
  if (!device) return;
  void device.trigger(PRESET[name]).catch(() => {
    // A haptic that cannot play is not an error the host needs to hear about.
  });
}

/**
 * Stop anything playing and drop the instance, including the node the iOS
 * fallback appended. For teardown and for tests, which would otherwise share
 * one engine across files.
 */
export function resetHaptics(): void {
  engine?.destroy();
  engine = undefined;
}
