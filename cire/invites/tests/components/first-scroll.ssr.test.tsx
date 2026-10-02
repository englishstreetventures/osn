import { Suspense } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import { expect, it } from "vitest";

import { createFirstScroll } from "../../src/components/first-scroll";

function Probe() {
  const scrolled = createFirstScroll();
  return <i data-scrolled={String(scrolled())} />;
}

/**
 * The latch in the server build, rendered the way Astro's Solid renderer does:
 * `renderToStringAsync` around a `Suspense`, which also disposes the render. A
 * `window` touched in the body or in a cleanup outside `onMount` throws here,
 * by name, rather than as a timeout in a page-level test.
 */
it("reads as unscrolled on the server, and touches no window to render or dispose", async () => {
  expect(typeof window).toBe("undefined");
  const html = await renderToStringAsync(() => (
    <Suspense>
      <Probe />
    </Suspense>
  ));
  expect(html).toContain('data-scrolled="false"');
}, 1000);
