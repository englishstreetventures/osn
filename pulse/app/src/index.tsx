/* @refresh reload */
import { render } from "solid-js/web";

import App from "./App";
import { installNativeSession } from "./lib/nativeSession";

// Before anything renders, so no sign-in can start on the wrong transport.
installNativeSession();

render(() => <App />, document.getElementById("root") as HTMLElement);
