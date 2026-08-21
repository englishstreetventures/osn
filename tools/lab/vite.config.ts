import { fileURLToPath } from "node:url";

import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The lab's root is `tools/lab`, but stories live next to the components they
// exercise anywhere in the monorepo. Vite refuses to serve files outside the
// root unless they are allow-listed, so the repo root goes on the list.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  // Bun installs solid-js into each workspace's own node_modules rather than
  // hoisting it, so a story imported from `pulse/web` resolves a *second* copy
  // of the runtime. Two Solid instances do not share a reactive graph: context
  // reads come back undefined and effects silently never fire. Dedupe pins
  // every import to one copy.
  resolve: { dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
  clearScreen: false,
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running `dev:app`
  // directly). `strictPort` keeps the promise that the lab fails rather than
  // silently moving somewhere the proxy is not looking.
  server: {
    port: devPort(4400),
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  // `vite preview` reads its own port, not the dev server's, so it needs the
  // same treatment rather than the 4173 default.
  preview: { port: devPort(4400), strictPort: true },
  // Nothing here ships. Sourcemaps and readable output are worth more than
  // bytes, and a spike gets thrown away long before size matters.
  build: { sourcemap: true, minify: false },
});
