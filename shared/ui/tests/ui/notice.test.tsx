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

const TODAY =
  "base:font-ui-body base:flex base:items-start base:gap-2.5 base:rounded-ui-sm " +
  "base:border base:p-4 base:text-ui-base base:leading-ui-relaxed " +
  "base:border-ui-hairline base:bg-ui-surface/30 base:text-ui-ink-secondary";

describe("Notice's default", () => {
  it("renders the classes it rendered before it had sizes", () => {
    const { container } = render(() => <Notice>standing note</Notice>);
    expect(container.firstElementChild?.getAttribute("class")).toBe(TODAY);
  });

  it("appends a caller's class last, after its own", () => {
    const { container } = render(() => <Notice class="mt-4">standing note</Notice>);
    expect(container.firstElementChild?.getAttribute("class")).toBe(`${TODAY} mt-4`);
  });
});
