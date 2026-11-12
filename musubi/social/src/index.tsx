/* @refresh reload */
import { render } from "solid-js/web";

import App from "./App";
import { captureEmailLinkSecret } from "./lib/email-link";
import { initTheme } from "./lib/theme";

// An emailed link's secret leaves the address bar before anything renders
// or fetches.
captureEmailLinkSecret();
initTheme();

render(() => <App />, document.getElementById("root") as HTMLElement);
