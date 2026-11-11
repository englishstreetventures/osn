/* @refresh reload */
import { render } from "solid-js/web";

import App from "./App";
import { redirectToCanonicalHost } from "./lib/canonical-host";
import { captureEmailLinkSecret } from "./lib/email-link";
import { initTheme } from "./lib/theme";

// Skip the boot entirely on the pages.dev copy — a redirect is under way and
// anything mounted here would only fire requests that cannot succeed.
if (!redirectToCanonicalHost()) {
  // An emailed link's secret leaves the address bar before anything renders
  // or fetches; the redirect above needed it still there.
  captureEmailLinkSecret();
  initTheme();

  render(() => <App />, document.getElementById("root") as HTMLElement);
}
