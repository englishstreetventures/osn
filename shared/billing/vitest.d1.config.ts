import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/d1/**/*.test.ts"], testTimeout: 30_000 },
});
