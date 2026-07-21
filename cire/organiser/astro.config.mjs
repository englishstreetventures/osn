import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "static",
  integrations: [solidJs()],
  vite: {
    plugins: [tailwindcss()],
  },
});
