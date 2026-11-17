import { __resetChangeBasis } from "../../src/lib/change-basis";
import { __resetDirectoryCache } from "../../src/lib/directory-store";
import { __resetHostsPanelCache } from "../../src/lib/hosts-store";
import { __resetInviteCache } from "../../src/lib/invite-store";
import { __resetRsvpsCache } from "../../src/lib/rsvps-store";
import { __resetSettingsCache } from "../../src/lib/settings-store";
import { __resetStarterPreview } from "../../src/lib/starter-store";

/**
 * Forget what the portal's view caches hold (`createWeddingCache` and the
 * editors' basis), so a view a later case mounts for the same wedding reads
 * afresh rather than drawing an earlier case's rows. `resetOrganiserMocks`
 * calls it; a suite with mocks of its own calls it after each case.
 */
export function resetViewCaches(): void {
  __resetChangeBasis();
  __resetDirectoryCache();
  __resetHostsPanelCache();
  __resetInviteCache();
  __resetRsvpsCache();
  __resetSettingsCache();
  __resetStarterPreview();
}
