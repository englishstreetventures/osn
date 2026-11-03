import { WebHaptics } from "web-haptics";

/**
 * Touch feedback for the portals.
 *
 * A portal names the *event*, never the waveform: `commit` is "that landed",
 * `reject` is "that did not", and what either feels like is one table below
 * rather than a duration scattered across the call sites.
 *
 * Five names in all, and each portal takes only the ones it has a use for
 * (`names`): the host portal all five, since it drags to reorder; the vendor
 * portal three. A small vocabulary is the whole point — haptics stop meaning
 * anything the moment every tap has its own flavour, and a phone in a pocket
 * buzzing through a seating chart is worse than no feedback at all. Module
 * switches, sub-tab switches and card taps are silent by design: they are
 * navigation, and navigation already answers with the screen.
 *
 * Not gated on `prefers-reduced-motion`. That setting is about vestibular
 * discomfort from things moving on screen; some of the same people rely on
 * touch feedback precisely *because* they have animation turned off. The
 * portal's own switch in the profile menu is the only control.
 *
 * On Android and Chrome this is the Vibration API. On iOS `navigator.vibrate`
 * does not exist, and the library falls back to clicking a hidden
 * `<input type="checkbox" switch>` — Safari 17.4+ plays the system switch
 * haptic for it. Everywhere else the calls are inert. Inside a cross-origin
 * iframe the Vibration API is blocked by permissions policy, so the host's
 * invite preview pane cannot buzz the phone from a guest-side interaction.
 */

export type Haptic =
  /** A change took: a checklist tick, a saved form, a committed drag, a sent reply, a copy. */
  | "commit"
  /** A change did not take: a rejected save, a failed send, a failed validation. */
  | "reject"
  /** A drag lifted off. */
  | "pickup"
  /** A drag crossed into the next slot. */
  | "step"
  /** A sheet, a modal or a menu went away. */
  | "dismiss";

/** Semantic name → the library's preset. The only place a waveform is chosen. */
const PRESET = {
  commit: "success",
  reject: "error",
  pickup: "medium",
  step: "selection",
  dismiss: "soft",
} satisfies Readonly<Record<Haptic, string>>;

export interface Haptics<N extends Haptic> {
  /**
   * Fire one. Silent when haptics are off, when there is no document, for a
   * name this set was not made with, and — by the library's own guards — when
   * the platform cannot deliver it.
   *
   * Deliberately fire-and-forget: `trigger()` resolves when the *pattern* has
   * finished playing, which is up to a couple of hundred milliseconds later, and
   * no caller should be waiting on that before updating the screen.
   */
  haptic(name: N): void;
  /**
   * Whether this build can produce touch feedback at all — which is the
   * question the profile menu's switch is asking, and deliberately *not* the
   * same question as `WebHaptics.isSupported`.
   *
   * `isSupported` is `typeof navigator.vibrate === "function"`, which is false
   * on iOS Safari — the one platform where the switch-element fallback actually
   * plays a system haptic. Gating the control on it would hide the off switch
   * on the only device that buzzes, and show it on desktop Chrome, where
   * `navigator.vibrate` exists and does nothing. So the gate is "there is a
   * document to hang the fallback on", and the library's own guards decide
   * whether anything is delivered.
   */
  hapticsAvailable(): boolean;
  /**
   * Stop anything playing and drop the engine, including the node the iOS
   * fallback appended. For teardown and for tests, which would otherwise share
   * one engine across files.
   */
  resetHaptics(): void;
}

export function createHaptics<const N extends Haptic>(options: {
  /** The portal's haptics switch, read at each call. */
  enabled: () => boolean;
  /** The names this portal fires; `haptic` takes no other. */
  names: readonly N[];
}): Haptics<N> {
  const presets = new Map<Haptic, (typeof PRESET)[Haptic]>(
    options.names.map((name) => [name, PRESET[name]]),
  );
  let engine: WebHaptics | undefined;

  /**
   * The one instance, built on first use. Lazy because the iOS fallback
   * appends a hidden `<label>` to `document.body`, which a constructor run at
   * module scope would do during hydration whether or not anything is ever
   * triggered — and, under SSR or a bare test environment, would do to a
   * document that is not there.
   */
  function instance(): WebHaptics | undefined {
    if (typeof document === "undefined") return undefined;
    engine ??= new WebHaptics({ showSwitch: false });
    return engine;
  }

  return {
    haptic(name) {
      if (!options.enabled()) return;
      const preset = presets.get(name);
      if (preset === undefined) return;
      const device = instance();
      if (!device) return;
      void device.trigger(preset).catch(() => {
        // A haptic that cannot play is not an error anyone needs to hear about.
      });
    },
    hapticsAvailable() {
      return typeof document !== "undefined";
    },
    resetHaptics() {
      engine?.destroy();
      engine = undefined;
    },
  };
}
