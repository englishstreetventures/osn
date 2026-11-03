import { createHaptics } from "@cire/ui/lib/haptics";

import { hapticsEnabled } from "./preferences";

/**
 * Touch feedback for the vendor portal, gated on the switch in the profile
 * menu. What each name feels like, and why the set is this small, is in
 * `@cire/ui/lib/haptics`.
 *
 * Three names: `commit` (a saved listing, a sent reply, a sent quote, a
 * claimed listing), `reject` (a rejected save, a failed send, a dead claim
 * link) and `dismiss`. The host portal also has `pickup` and `step`, because
 * it drags to reorder; this portal does not, and a name with no call site is
 * a name the next person will find something to use it for. View switches
 * and list taps are silent: they are navigation, and navigation already
 * answers with the screen.
 */
export const { haptic, hapticsAvailable, resetHaptics } = createHaptics({
  enabled: hapticsEnabled,
  names: ["commit", "reject", "dismiss"],
});
