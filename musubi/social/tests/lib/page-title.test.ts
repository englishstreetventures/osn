// @vitest-environment happy-dom
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { usePageTitle } from "../../src/lib/page-title";

/** Mounts a page that titles itself; returns its unmount. */
function mountPage(title: () => string | undefined): () => void {
  return createRoot((dispose) => {
    usePageTitle(title);
    return dispose;
  });
}

afterEach(() => {
  document.title = "Musubi";
});

describe("usePageTitle", () => {
  it("names the page ahead of the product", () => {
    const unmount = mountPage(() => "Discover");
    expect(document.title).toBe("Discover · Musubi");
    unmount();
  });

  it("follows a title that arrives or changes after mount", () => {
    const [name, setName] = createSignal<string | undefined>("Organisations");
    const unmount = mountPage(name);
    expect(document.title).toBe("Organisations · Musubi");

    setName("Walkers Club");
    expect(document.title).toBe("Walkers Club · Musubi");
    unmount();
  });

  it("gives the product name back when the page goes", () => {
    const unmount = mountPage(() => "Settings");
    unmount();
    expect(document.title).toBe("Musubi");
  });

  it("shows the product name alone for a page with no title yet", () => {
    const unmountEmpty = mountPage(() => "");
    expect(document.title).toBe("Musubi");
    unmountEmpty();

    const unmountUndefined = mountPage(() => undefined);
    expect(document.title).toBe("Musubi");
    unmountUndefined();
  });

  it("leaves the next page's title alone when the last page unmounts after it", () => {
    const unmountOld = mountPage(() => "Connections");
    const unmountNew = mountPage(() => "Connections");
    unmountOld();
    expect(document.title).toBe("Connections · Musubi");
    unmountNew();
    expect(document.title).toBe("Musubi");
  });
});
