import { describe, expect, it, vi } from "vitest";

import { reloadOnRestore } from "../../src/lib/bfcache";

/** A window whose `location.reload` is a spy; everything else is the real one. */
function fakeWindow() {
  const target = new EventTarget();
  const reload = vi.fn();
  const win = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    location: { reload },
  } as unknown as Window;
  const pageshow = (persisted: boolean) => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: persisted });
    target.dispatchEvent(event);
  };
  return { win, reload, pageshow };
}

describe("reloadOnRestore", () => {
  it("reloads a page restored from the back/forward cache", () => {
    const { win, reload, pageshow } = fakeWindow();
    reloadOnRestore(win);
    pageshow(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary page load alone", () => {
    const { win, reload, pageshow } = fakeWindow();
    reloadOnRestore(win);
    pageshow(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops listening once removed", () => {
    const { win, reload, pageshow } = fakeWindow();
    reloadOnRestore(win)();
    pageshow(true);
    expect(reload).not.toHaveBeenCalled();
  });
});
