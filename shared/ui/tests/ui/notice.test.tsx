// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { Notice } from "../../src/ui/notice";

/**
 * `Notice` is drawn in musubi, pulse and cire, and gaining sizes and a tone
 * must not move any of them. So, unlike the rest of this package's tests, this
 * one reads the class list by name: the default box is a promise to every app
 * that already renders one, and a different string is a different box. The
 * browser tier (`primitives.browser.test.tsx`) checks the same default by its
 * computed look.
 */

afterEach(cleanup);

const BOX =
  "base:font-ui-body base:flex base:items-start base:gap-2.5 base:rounded-ui-sm " +
  "base:border base:p-4 base:text-ui-base base:leading-ui-relaxed";

/** Each tone's classes as they were before `Notice` had sizes. */
const TODAY = {
  danger: `${BOX} base:border-ui-danger/20 base:bg-ui-danger/5 base:text-ui-danger`,
  warn: `${BOX} base:border-ui-warn/20 base:bg-ui-warn/5 base:text-ui-warn`,
  success: `${BOX} base:border-ui-success/20 base:bg-ui-success/5 base:text-ui-success`,
  info: `${BOX} base:border-ui-hairline base:bg-ui-surface/30 base:text-ui-ink-secondary`,
} as const;

describe("Notice's default size", () => {
  it.each(["danger", "warn", "success", "info"] as const)(
    "renders the %s classes it rendered before",
    (tone) => {
      const { container } = render(() => <Notice tone={tone}>standing note</Notice>);
      expect(container.firstElementChild?.getAttribute("class")).toBe(TODAY[tone]);
    },
  );

  it("is `info` with no tone, and appends a caller's class last", () => {
    const { container } = render(() => <Notice class="mt-4">standing note</Notice>);
    expect(container.firstElementChild?.getAttribute("class")).toBe(`${TODAY.info} mt-4`);
  });
});
