import { fileURLToPath } from "node:url";

import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The dashboard's root is `tools/metrics`, but the cards it charts live at
// `.claude/metrics/*.json` in the repo root. Vite refuses to serve files
// outside the root unless they are allow-listed, so the repo root goes on the
// list — without it every card import 403s.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  // Bun installs solid-js into each workspace's own node_modules rather than
  // hoisting it, so `@osn/ui` resolves a *second* copy of the runtime. Two
  // Solid instances do not share a reactive graph: context reads come back
  // undefined and effects silently never fire. Dedupe pins every import to
  // one copy. Same fix as `tools/lab`.
  resolve: { dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
  clearScreen: false,
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running `dev:app`
  // directly). `strictPort` keeps the promise that the dashboard fails rather
  // than silently moving somewhere the proxy is not looking.
  server: {
    port: devPort(4401),
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  preview: { port: devPort(4401), strictPort: true },
  // Nothing here ships. Readable output is worth more than bytes.
  build: { sourcemap: true, minify: false },
});
