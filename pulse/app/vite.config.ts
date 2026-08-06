import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), solid()],

  clearScreen: false,
  // Fixed port so dependent tooling (e.g. `@osn/social` dev proxy) can rely
  // on it; fail rather than silently move to another port.
  server: {
    port: 1420,
    strictPort: true,
  },
}));
