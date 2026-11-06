import { devPort } from "@shared/dev-urls";
import { solidStart } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  // Pages render on the server. pulse-api is mounted on this origin under
  // `/api` (`src/routes/api/[...path].ts`), so its session cookie is host-only
  // here and reaches the rendering server with every page request, which
  // passes it on to pulse-api (`src/lib/transport.ts`): a signed-in page
  // arrives filled in.
  plugins: [tailwindcss(), solidStart({ ssr: true }), nitro()],

  // Vite's dependency scan starts at the client entry and cannot follow the
  // route modules SolidStart loads lazily, so a dependency only a route
  // imports was found on the first page load, and Vite then reloaded that
  // page: by then the server-rendered page is on screen, and a click on it is
  // lost to the reload. Scanning every source file finds them at start.
  // The scan does not report Leaflet, which the map imports only once it
  // mounts, so it is named. SolidStart's dev overlay ships untransformed, so
  // its source-map reader, which imports a UMD module, has to be pre-bundled
  // to load at all.
  optimizeDeps: {
    entries: ["src/**/*.{ts,tsx}"],
    include: ["leaflet", "@solidjs/start > @jridgewell/trace-mapping"],
  },

  clearScreen: false,
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running
  // `dev:app` directly). `strictPort` keeps the old promise that the app
  // fails rather than silently moving to another port.
  server: {
    port: devPort(1420),
    strictPort: true,
    // SolidStart builds the browser's route table on first request, and each
    // route it adds there schedules a hot update of the app 200 ms later,
    // which re-renders the first page a browser loads and drops a press made
    // on it. Warming `app.tsx` builds that table as the server starts.
    warmup: { clientFiles: ["./src/app.tsx"] },
  },
});
