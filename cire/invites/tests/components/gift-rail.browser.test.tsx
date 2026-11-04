import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import documentSource from "../../src/components/gift-registry/GiftRegistryDocument.astro?raw";

/*
 * The gift page says its way back once: the
 * sticky rail (`GiftRegistryDocument.astro`'s `data-gift-rail`) while the list
 * is open, and only the closed page's own pill (`GiftRegistryPage.tsx`'s
 * `data-gift-closed` block) once the couple have closed it. Measured under the
 * site's stylesheet, with the two marks the page and the island write.
 */

afterEach(cleanup);

function Page(props: { closed: boolean }) {
  return (
    <div>
      <nav data-gift-rail aria-label="Invitation">
        <a href="/invite">Back to the invitation</a>
      </nav>
      {props.closed ? (
        <div data-gift-closed>
          <a href="/invite">Back to the invitation</a>
        </div>
      ) : (
        <ul aria-label="Gifts" />
      )}
    </div>
  );
}

describe("the gift page's way back", () => {
  it("rides the rail while the list is open", () => {
    const { container } = render(() => <Page closed={false} />);
    expect(getComputedStyle(container.querySelector("[data-gift-rail]")!).visibility).toBe(
      "visible",
    );
  });

  it("is the closed page's pill alone once the list is closed, the rail's box kept so nothing moves", () => {
    const { container } = render(() => <Page closed />);
    const rail = container.querySelector("[data-gift-rail]")!;
    expect(getComputedStyle(rail).visibility).toBe("hidden");
    expect(rail.getBoundingClientRect().height).toBeGreaterThan(0);
  });

  it("holds the mark the document writes on its rail", () => {
    // The island's end, `data-gift-closed`, is held by
    // `GiftRegistryPage.test.tsx`; this is the document's.
    expect(documentSource).toMatch(/<nav[^>]*\sdata-gift-rail\b/);
  });
});
