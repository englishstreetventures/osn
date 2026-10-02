import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFirstScroll } from "../../src/components/first-scroll";

/**
 * jsdom implements no scrolling: `scrollTo` only logs "not implemented". So the
 * page's position is set by assigning `scrollY` (jsdom leaves it replaceable)
 * and the browser's part is played by dispatching the `scroll` event by hand.
 */
function scrollPageTo(y: number) {
  window.scrollY = y;
  window.dispatchEvent(new Event("scroll"));
}

/** `onMount` runs after the root's body, on Solid's queue; let it run. */
const flushMount = () => Promise.resolve();

afterEach(() => {
  window.scrollY = 0;
  vi.restoreAllMocks();
});

describe("createFirstScroll", () => {
  it("is false at the top of the page", async () => {
    await createRoot(async (dispose) => {
      const scrolled = createFirstScroll();
      await flushMount();
      expect(scrolled()).toBe(false);
      dispose();
    });
  });

  it("turns true on the first scroll down the page", async () => {
    await createRoot(async (dispose) => {
      const scrolled = createFirstScroll();
      await flushMount();
      scrollPageTo(1);
      expect(scrolled()).toBe(true);
      dispose();
    });
  });

  it("ignores a scroll event that leaves the page at the top", async () => {
    // iOS rubber-banding reports a scroll at or above 0 when the guest pulls
    // the top of the page down; that is not the guest moving into the invite.
    await createRoot(async (dispose) => {
      const scrolled = createFirstScroll();
      await flushMount();
      scrollPageTo(0);
      scrollPageTo(-40);
      expect(scrolled()).toBe(false);
      dispose();
    });
  });

  it("stays true after the guest scrolls back to the top", async () => {
    await createRoot(async (dispose) => {
      const scrolled = createFirstScroll();
      await flushMount();
      scrollPageTo(300);
      scrollPageTo(0);
      expect(scrolled()).toBe(true);
      dispose();
    });
  });

  it("is true at mount when the page is already scrolled", async () => {
    // A reload part-way down the invite: the browser restores the position
    // before the island mounts, and may fire no scroll event after it.
    window.scrollY = 500;
    await createRoot(async (dispose) => {
      const scrolled = createFirstScroll();
      await flushMount();
      expect(scrolled()).toBe(true);
      dispose();
    });
  });

  it("stops listening once it has latched", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    await createRoot(async (dispose) => {
      createFirstScroll();
      await flushMount();
      scrollPageTo(10);
      expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
      dispose();
    });
  });

  it("listens passively and stops listening when its owner is disposed", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    await createRoot(async (dispose) => {
      createFirstScroll();
      await flushMount();
      const call = add.mock.calls.find(([type]) => type === "scroll");
      expect(call?.[2]).toEqual({ passive: true });
      dispose();
      expect(remove).toHaveBeenCalledWith("scroll", call?.[1]);
    });
  });

  it("adds no listener when the page is already scrolled at mount", async () => {
    window.scrollY = 500;
    const add = vi.spyOn(window, "addEventListener");
    await createRoot(async (dispose) => {
      createFirstScroll();
      await flushMount();
      expect(add.mock.calls.some(([type]) => type === "scroll")).toBe(false);
      dispose();
    });
  });
});
