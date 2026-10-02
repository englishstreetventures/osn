import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_BANNER_HEIGHT_VAR,
  publishBannerHeight,
} from "../../../src/components/consent/banner-height";
import { FakeResizeObserver, installFakeResizeObserver } from "../../test-support/resize-observer";

const published = () => document.documentElement.style.getPropertyValue(CONSENT_BANNER_HEIGHT_VAR);

beforeEach(installFakeResizeObserver);

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(CONSENT_BANNER_HEIGHT_VAR);
});

describe("publishBannerHeight", () => {
  it("writes the banner's height on <html>, and follows it as it changes", () => {
    const banner = document.createElement("section");
    createRoot((dispose) => {
      publishBannerHeight(banner);
      const [observer] = FakeResizeObserver.instances;
      expect(observer?.observed.has(banner)).toBe(true);

      observer!.resize(banner, 182.5);
      expect(published()).toBe("182.5px");
      // The copy rewraps at another width, or once the web fonts land.
      observer!.resize(banner, 126);
      expect(published()).toBe("126px");
      dispose();
    });
  });

  it("takes the height away and stops observing when its owner is disposed", () => {
    const banner = document.createElement("section");
    createRoot((dispose) => {
      publishBannerHeight(banner);
      const [observer] = FakeResizeObserver.instances;
      observer!.resize(banner, 182.5);

      dispose();

      expect(published()).toBe("");
      expect(observer!.disconnected).toBe(true);
    });
  });

  it("leaves every other inline style on <html> alone", () => {
    const root = document.documentElement;
    root.style.setProperty("--some-other-var", "1px");
    const banner = document.createElement("section");
    createRoot((dispose) => {
      publishBannerHeight(banner);
      FakeResizeObserver.instances[0]!.resize(banner, 90);
      dispose();
    });
    expect(root.style.getPropertyValue("--some-other-var")).toBe("1px");
    root.style.removeProperty("--some-other-var");
  });
});
