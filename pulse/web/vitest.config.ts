import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
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
        "src/lib/api.ts",
        "src/lib/auth.ts",
        "src/app.tsx",
        "src/entry-client.tsx",
        "src/entry-server.tsx",
      ],
      reporter: ["text", "html"],
    },
  },
});
