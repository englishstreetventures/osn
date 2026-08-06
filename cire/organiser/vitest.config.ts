import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // A NON-UTC runner zone, deliberately. Several tests assert that a new
    // event is seeded with "the organiser's own zone" by comparing against
    // `Intl.DateTimeFormat().resolvedOptions().timeZone` — under a UTC runner
    // that string is "UTC", which is also `browserTimeZone`'s hardcoded
    // fallback, so a `browserTimeZone` rewritten as `() => "UTC"` passed them
    // all. Pinning a real zone makes those assertions falsifiable.
    env: { TZ: "Australia/Sydney" },
  },
});
