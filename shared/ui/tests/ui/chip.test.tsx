// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { Chip } from "../../src/ui/chip";

/**
 * `Chip` gaining variants must not move the neutral chip the portals already
 * draw, so this reads its default class list by name, as `notice.test.tsx`
 * does. The other filled tones moved on purpose — to an 8% tint, so their words
 * clear 4.5:1 on cire's pale theme (owner, englishstreetventures/osn#1836) —
 * and `cire/host`'s `chip-contrast.browser.test.tsx` holds what they paint.
 */

afterEach(cleanup);

const TODAY =
  "base:font-ui-body base:inline-flex base:shrink-0 base:items-center base:rounded-ui-pill " +
  "base:px-2.5 base:py-0.5 base:text-ui-xs base:tracking-ui-wider base:whitespace-nowrap base:uppercase " +
  "base:bg-ui-surface/60 base:text-ui-ink-secondary";

describe("Chip's default", () => {
  it("renders the neutral classes it rendered before", () => {
    const { container } = render(() => <Chip>draft</Chip>);
    expect(container.firstElementChild?.getAttribute("class")).toBe(TODAY);
  });

  it("appends a caller's class last", () => {
    const { container } = render(() => <Chip class="mt-1">draft</Chip>);
    expect(container.firstElementChild?.getAttribute("class")).toBe(`${TODAY} mt-1`);
  });
});
