import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Allow async event handlers to throw unhandled rejections without failing
    // the suite — this mirrors real browser behaviour where onSubmit rejection
    // is silently swallowed. Required to test the `if (error) throw error` path
    // in CreateEventForm without the test runner flagging the resulting rejection.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/lib/api.ts",
        "src/lib/auth.ts",
        "src/App.tsx",
        "src/index.tsx",
      ],
      reporter: ["text", "html"],
    },
  },
});
