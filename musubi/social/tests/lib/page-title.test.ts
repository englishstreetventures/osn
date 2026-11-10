// @vitest-environment happy-dom
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { usePageTitle } from "../../src/lib/page-title";

/** Every page a case mounted, so `afterEach` can unmount what a failed case left. */
const mounted: (() => void)[] = [];

/** Mounts a page that titles itself; returns its unmount. */
function mountPage(title: () => string | undefined): () => void {
  const dispose = createRoot((d) => {
    usePageTitle(title);
    return d;
  });
  mounted.push(dispose);
  return dispose;
}

afterEach(() => {
  // Unmounting releases the module's owner, so one failing case cannot leave
  // the next one a title it does not own. Disposing twice is a no-op.
  for (const dispose of mounted.splice(0)) dispose();
  document.title = "Musubi";
});

describe("usePageTitle", () => {
  it("names the page ahead of the product", () => {
    mountPage(() => "Discover");
    expect(document.title).toBe("Discover · Musubi");
  });

  it("follows a title that arrives or changes after mount", () => {
    const [name, setName] = createSignal<string | undefined>("Organisations");
    mountPage(name);
    expect(document.title).toBe("Organisations · Musubi");

    setName("Walkers Club");
    expect(document.title).toBe("Walkers Club · Musubi");
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

    mountPage(() => undefined);
    expect(document.title).toBe("Musubi");
  });

  it("leaves the next page's title alone when the last page unmounts after it", () => {
    const unmountOld = mountPage(() => "Organisations");
    const unmountNew = mountPage(() => "Discover");
    unmountOld();
    expect(document.title).toBe("Discover · Musubi");
    unmountNew();
    expect(document.title).toBe("Musubi");
  });

  it("keeps the next page's title when the last page's title changes before it unmounts", () => {
    const [oldName, setOldName] = createSignal<string | undefined>("Organisations");
    const unmountOld = mountPage(oldName);
    mountPage(() => "Discover");

    setOldName("Acme");
    expect(document.title).toBe("Discover · Musubi");
    unmountOld();
    expect(document.title).toBe("Discover · Musubi");
  });
});
