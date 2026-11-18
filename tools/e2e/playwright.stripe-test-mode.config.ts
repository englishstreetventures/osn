import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

// The run against Stripe's test mode (`src/stripe-test-mode-launcher.ts`):
// the suite's settings, its one flow, and room for Stripe's own round trips
// and the event `stripe listen` forwards.
export default defineConfig({
  ...base,
  testDir: "./tests/stripe-test-mode",
  timeout: 180_000,
});
