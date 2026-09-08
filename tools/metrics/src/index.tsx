/* @refresh reload */
import { render } from "solid-js/web";

import { Dashboard } from "./Dashboard.tsx";

import "./metrics.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

render(() => <Dashboard />, root);
