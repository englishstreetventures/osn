import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { createHeroBackdrop } from "./hero-backdrop";

describe("createHeroBackdrop", () => {
  it("starts pending and transitions on load/error", () => {
    createRoot((dispose) => {
      const [src] = createSignal<string | null>("/img?variant=hero-bg");
      const hb = createHeroBackdrop(src);
      expect(hb.state()).toBe("pending");
      hb.onLoad();
      expect(hb.state()).toBe("loaded");
      hb.onError();
      expect(hb.state()).toBe("error");
      dispose();
    });
  });

  it("re-arms to pending only when the src actually changes", async () => {
    await createRoot(async (dispose) => {
      const [src, setSrc] = createSignal<string | null>("/a");
      const hb = createHeroBackdrop(src);
      // The re-arm effect's first run (adopting the initial src into `prevSrc`)
      // is queued, not synchronous outside a component render tree — flush it
      // before asserting, same as the onMount flush below.
      await Promise.resolve();
      hb.onLoad();
      setSrc("/a"); // same value — Solid won't re-run, state stays loaded
      await Promise.resolve();
      expect(hb.state()).toBe("loaded");
      setSrc("/b");
      await Promise.resolve();
      expect(hb.state()).toBe("pending");
      dispose();
    });
  });

  it("marks loaded on mount when the ref'd image already completed", () => {
    // jsdom images are never complete-with-naturalWidth; simulate via a stub object.
    createRoot((dispose) => {
      const [src] = createSignal<string | null>("/a");
      const hb = createHeroBackdrop(src);
      hb.setImgRef({ complete: true, naturalWidth: 100 } as HTMLImageElement);
      // onMount runs after createRoot body in Solid's microtask; flush:
      return Promise.resolve().then(() => {
        expect(hb.state()).toBe("loaded");
        dispose();
      });
    });
  });
});
