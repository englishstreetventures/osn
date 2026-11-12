import { ResponsiveSkeleton } from "./ResponsiveSkeleton";

/**
 * Settings → Connected apps' placeholder: one app row, spaced as the list is.
 * The row is 62px, and 66px below `md`, where Revoke takes the touch height.
 * `ConnectedAppsSection` draws it while its list is read, and `SettingsPage`
 * while the section's code loads, so nothing moves when either lands. Its own
 * module, so the page can draw it without loading the section.
 */
export function AppRowsLoading() {
  return (
    <div class="flex flex-col gap-2">
      <ResponsiveSkeleton standsFor="card" height={15.5} phoneHeight={16.5} />
    </div>
  );
}
