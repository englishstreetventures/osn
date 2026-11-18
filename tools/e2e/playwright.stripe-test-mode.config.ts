import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

/**
 * The browser's environment: the runner's, without the Stripe key. The flow
 * calls Stripe from the worker; the browser, which runs Stripe's own pages,
 * has no use for the key. Left unset, Playwright hands the browser the
 * runner's whole environment.
 */
export const browserEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "STRIPE_TEST_SECRET_KEY",
    ),
  );

// The run against Stripe's test mode (`src/stripe-test-mode-launcher.ts`):
// the suite's settings, its one flow, and room for Stripe's own round trips
// and the event `stripe listen` forwards.
export default defineConfig({
  ...base,
  testDir: "./tests/stripe-test-mode",
  timeout: 180_000,
  use: {
    ...base.use,
    launchOptions: { ...base.use?.launchOptions, env: browserEnv(process.env) },
  },
});
