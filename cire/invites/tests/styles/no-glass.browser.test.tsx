import { GLASS_FILL } from "@cire/ui/lib/glass";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/*
 * The guest site draws no glass: it leaves `@cire/ui`'s `lib/glass.ts` out of
 * its Tailwind scan, beside `segmented-tabs.tsx`, so none of the portals'
 * frosted rules reaches an invite's stylesheet. Measured under the site's own
 * stylesheet: an element wearing every glass class paints none of them. It
 * goes red the moment the `@source not` line goes, or a guest file starts
 * spelling a glass class.
 */

afterEach(cleanup);

describe("the guest site's stylesheet", () => {
  it("carries none of the portals' glass", () => {
    const { container } = render(() => <span class={GLASS_FILL}>Glass</span>);
    const style = getComputedStyle(container.firstElementChild!);
    expect(style.backdropFilter).toBe("none");
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.boxShadow).toBe("none");
  });
});
