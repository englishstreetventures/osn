import type { PublicProfile } from "@osn/client";
import { toast } from "@shared/toast";
import { createRoot, createSignal } from "solid-js";

import { describeActionError } from "./action-error";

/**
 * Whether a profile switch is running. One for the page, not one per account
 * menu: each shell draws its own menu, and a switch started in one keeps its
 * guard when the window crosses 768px and the other shell's menu draws.
 */
const [switching, setSwitching] = createRoot(() => createSignal(false));

export { switching };

/**
 * Switches to `profile` and says how it went in a toast: "Switched to"
 * followed by the profile's handle, or the copy map's sentence for an ended
 * session, the error's own message, or "Failed to switch profile". A second
 * switch while one runs does nothing, so no two race to set the active
 * profile; the guard clears however the first one ends.
 */
export async function switchToProfile(
  switchProfile: (profileId: string) => Promise<{ profile: PublicProfile }>,
  profile: Pick<PublicProfile, "id">,
): Promise<void> {
  if (switching()) return;
  setSwitching(true);
  try {
    const result = await switchProfile(profile.id);
    toast.success(`Switched to @${result.profile.handle}`);
  } catch (err) {
    toast.error(describeActionError(err, "Failed to switch profile"));
  } finally {
    setSwitching(false);
  }
}
