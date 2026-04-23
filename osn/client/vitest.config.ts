import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"] },
});
