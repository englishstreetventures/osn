import { describe, expect, test } from "bun:test";

import { REMOTE_ENV_CHROMIUM, resolveChromium } from "../src/chromium";

const existing = (paths: string[]) => (p: string) => paths.includes(p);

describe("resolveChromium", () => {
  test("an explicit E2E_CHROMIUM_PATH wins", () => {
    expect(
      resolveChromium({ E2E_CHROMIUM_PATH: "/x/chrome" }, "/bundled", existing(["/bundled"])),
    ).toBe("/x/chrome");
  });

  test("then Playwright's own build, when installed", () => {
    expect(resolveChromium({}, "/bundled", existing(["/bundled", REMOTE_ENV_CHROMIUM]))).toBe(
      "/bundled",
    );
  });

  test("then the remote environment's build", () => {
    expect(resolveChromium({}, "/bundled", existing([REMOTE_ENV_CHROMIUM]))).toBe(
      REMOTE_ENV_CHROMIUM,
    );
  });

  test("otherwise leaves the choice, and the missing-browser error, to Playwright", () => {
    expect(resolveChromium({}, undefined, existing([]))).toBeUndefined();
  });
});
