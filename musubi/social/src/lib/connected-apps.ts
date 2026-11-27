import type { OidcConnection } from "@osn/client";

import { followableLink } from "./account-deletion";

/**
 * A Settings → Connected apps row's kind, which sets its placeholder's
 * height: `link` when the row draws its app's removal link on a line of its
 * own, a taller row, and `plain` otherwise.
 */
export type AppRowKind = "plain" | "link";

/**
 * Where a Connected apps row's "Remove my data from <app>" link goes, or null
 * for no link: the app sent its own screen for removing a person's data, at an
 * address the page follows (`followableLink`), and has a name the link can say.
 */
export function removalLink(
  app: Pick<OidcConnection, "clientName" | "manageDataUrl">,
): string | null {
  return app.clientName === null ? null : followableLink(app.manageDataUrl);
}

/** The kind of row `app` draws, for the page cache to keep for its placeholder. */
export function appRowKind(app: Pick<OidcConnection, "clientName" | "manageDataUrl">): AppRowKind {
  return removalLink(app) === null ? "plain" : "link";
}
