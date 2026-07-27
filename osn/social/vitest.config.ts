import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.{ts,tsx}"],
      // `src/lib/auth.ts` was excluded while it held a single constant. It now
      // carries the Turnstile sitekey normalisation, which has tests — keep it
      // visible so a regression there shows up as a coverage drop.
      exclude: ["src/index.tsx", "src/App.tsx"],
      reporter: ["text", "html"],
    },
  },
});
