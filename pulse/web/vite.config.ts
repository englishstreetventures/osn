import { solidStart } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  // `ssr: false` keeps Pulse a client-rendered app. Server rendering needs the
  // issuer session cookie forwarded from the request — `@osn/client`'s
  // `authFetch` silently refreshes from an HttpOnly cookie on `id.musubi.social`,
  // which a server-side fetch does not carry — so every authed page would
  // render signed-out. That forwarding lands separately.
  plugins: [tailwindcss(), solidStart({ ssr: false }), nitro()],

  clearScreen: false,
  // Fixed port so dependent tooling (e.g. `@osn/social` dev proxy) can rely
  // on it; fail rather than silently move to another port.
  server: {
    port: 1420,
    strictPort: true,
  },
});
