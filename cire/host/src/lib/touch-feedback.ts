import { createHaptics } from "@cire/ui/lib/haptics";

import { hapticsEnabled } from "./preferences";

/**
 * Touch feedback for the host portal: all five names, since the host drags to
 * reorder, gated on the switch in the profile menu. What each name feels like,
 * and why the set is this small, is in `@cire/ui/lib/haptics`.
 *
 * Inside a cross-origin iframe the Vibration API is blocked by permissions
 * policy, so the invite preview pane cannot buzz the phone from a guest-side
 * interaction.
 */
export const { haptic, hapticsAvailable, resetHaptics } = createHaptics({
  enabled: hapticsEnabled,
  names: ["commit", "reject", "pickup", "step", "dismiss"],
});
