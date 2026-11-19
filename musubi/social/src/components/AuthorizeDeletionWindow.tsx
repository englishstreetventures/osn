import { AuthProvider } from "@osn/client/solid";

import { osnAuth } from "../lib/auth";
import DeletionWindow, { type DeletionWindowApp } from "./DeletionWindow";

/**
 * The deletion screen on the consent page, kept behind a `lazy()` boundary,
 * for a sign-in an app started by an account whose deletion is pending.
 *
 * The screen reads the deletion's status, downloads the data and keeps the
 * account with the session's own token, so it needs `AuthProvider`, which the
 * bare `/authorize` route does not mount. Mounted here, as `AuthorizeSignIn`
 * mounts its own: on the page's one runtime, so the two share one session
 * cache and one `/token` grant. Its first load trades the session cookie for a
 * token (`POST /token`), which renews the cookie the consent calls read; a
 * keep then renews it onto the ordinary audience once, and lists the
 * account's profiles once as it does, before the page moves on to consent.
 */
export function AuthorizeDeletionWindow(props: {
  app: DeletionWindowApp;
  onKept: () => void;
  onSignedOut: () => void;
}) {
  return (
    <AuthProvider auth={osnAuth}>
      <DeletionWindow app={props.app} onKept={props.onKept} onSignedOut={props.onSignedOut} />
    </AuthProvider>
  );
}
