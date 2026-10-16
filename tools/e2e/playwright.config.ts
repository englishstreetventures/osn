import { chromium, defineConfig } from "@playwright/test";

import { resolveChromium } from "./src/chromium";
import { TRACE_DIR } from "./src/config";

// The build this Playwright version was made for, when it is installed.
let bundled: string | undefined;
try {
  bundled = chromium.executablePath();
} catch {
  bundled = undefined;
}

export default defineConfig({
  testDir: "./tests/flows",
  testMatch: "*.flow.ts",
  outputDir: TRACE_DIR,
  // Serial and never retried: flows share the stack's in-memory rate limiters,
  // and a retry would turn a flake into a pass instead of a red run.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./src/reporter.ts"]],
  use: {
    trace: "on",
    screenshot: "off",
    video: "off",
    timezoneId: "UTC",
    locale: "en-AU",
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
    launchOptions: { executablePath: resolveChromium(process.env, bundled) },
  },
});
