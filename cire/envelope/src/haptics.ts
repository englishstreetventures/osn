/**
 * Touch feedback for the opening. One event, `open`: the tap that breaks the
 * seal. Later taps, which only speed the opening up, are silent.
 *
 * On Android Chrome this is the Vibration API; Chrome accepts it only inside
 * the tap's own handler, which is where the scene calls it. Everywhere else
 * the library's own guards make it do nothing. Not gated on reduced motion:
 * an opening never plays under it.
 */

import { WebHaptics } from "web-haptics";

/** The library preset each event plays. */
const PRESET = { open: "success" } as const;

let engine: WebHaptics | undefined;

export function haptic(event: keyof typeof PRESET): void {
  try {
    engine ??= new WebHaptics({ showSwitch: false });
    void engine.trigger(PRESET[event]).catch(() => {
      // A haptic that cannot play changes nothing the guest sees.
    });
  } catch {
    // Same: no haptic, the opening goes on.
  }
}
