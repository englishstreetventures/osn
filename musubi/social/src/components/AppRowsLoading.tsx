import { ResponsiveSkeleton } from "./ResponsiveSkeleton";

/**
 * Settings → Connected apps' placeholder: `count` app rows (one by default),
 * spaced as the list is. The row is 62px, and 66px below `md`, where Revoke
 * takes the touch height. `ConnectedAppsSection` draws it while its list is
 * first read, and `SettingsPage` while the section's code loads, both with
 * the count the list last landed, so nothing moves when either lands. Its own
 * module, so the page can draw it without loading the section.
 */
export function AppRowsLoading(props: { count?: number }) {
  return (
    <div class="flex flex-col gap-2">
      {Array.from({ length: props.count ?? 1 }, () => (
        <ResponsiveSkeleton standsFor="card" height={15.5} phoneHeight={16.5} />
      ))}
    </div>
  );
}
