import type { AppRowKind } from "../lib/connected-apps";
import { placeholderRows, placeholderKinds } from "../lib/page-cache";
import { PAGE_DATA } from "../lib/page-names";
import { ResponsiveSkeleton } from "./ResponsiveSkeleton";

const WITH_LINK: AppRowKind = "link";

/**
 * Settings → Connected apps' placeholder: a block for each app row the list
 * last landed (one when nothing is known), each at its own row's height,
 * spaced as the list is. A row is 70px, and 74px below `md`, where Revoke
 * takes the touch height; one with its app's removal link under it is 114px,
 * and 126px below `md`. `ConnectedAppsSection` draws it while its list is
 * first read, and `SettingsPage` while the section's code loads; both read
 * the count and the kinds from the page cache here, so they draw the same
 * blocks and nothing moves when either lands. Its own module, so the page can
 * draw it without loading the section.
 */
export function AppRowsLoading() {
  const kinds = placeholderKinds(PAGE_DATA.connectedApps) ?? [];
  return (
    <div class="flex flex-col gap-2">
      {Array.from({ length: placeholderRows(PAGE_DATA.connectedApps) }, (_, row) =>
        kinds[row] === WITH_LINK ? (
          <ResponsiveSkeleton standsFor="row" height={28.5} phoneHeight={31.5} />
        ) : (
          <ResponsiveSkeleton standsFor="row" height={17.5} phoneHeight={18.5} />
        ),
      )}
    </div>
  );
}
