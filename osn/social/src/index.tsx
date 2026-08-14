/* @refresh reload */
import { render } from "solid-js/web";

import App from "./App";
import { redirectToCanonicalHost } from "./lib/canonical-host";
import { initTheme } from "./lib/theme";

// Skip the boot entirely on the pages.dev copy — a redirect is under way and
// anything mounted here would only fire requests that cannot succeed.
if (!redirectToCanonicalHost()) {
  initTheme();

  render(() => <App />, document.getElementById("root") as HTMLElement);
}
