/* @refresh reload */
import { render } from "solid-js/web";

import { Lab } from "./Lab.tsx";

import "./lab.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

render(() => <Lab />, root);
