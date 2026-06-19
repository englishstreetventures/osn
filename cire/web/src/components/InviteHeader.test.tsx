import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import InviteHeader, { buildSrcSet, variantSrc } from "./InviteHeader";
import type { InviteCustomisation } from "./InviteHeader";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("buildSrcSet (T-M1)", () => {
  it("appends &variant=…<width>w for each variant when the base URL already has a query", () => {
    // Base ends with the ?v= content-version cache-buster, so the separator for
    // the appended &variant= must be `&` (not a second `?`).
    const srcset = buildSrcSet("/api/invite/s/image/hero?v=123", ["thumb", "card", "hero"]);
    expect(srcset).toBe(
      "/api/invite/s/image/hero?v=123&variant=thumb 320w, " +
        "/api/invite/s/image/hero?v=123&variant=card 800w, " +
        "/api/invite/s/image/hero?v=123&variant=hero 1600w",
    );
  });

  it("uses ? as the first separator when the base URL has no query", () => {
    const srcset = buildSrcSet("/img", ["thumb", "card"]);
    expect(srcset).toBe("/img?variant=thumb 320w, /img?variant=card 800w");
  });

  it("emits the correct width descriptor for each named variant", () => {
    expect(buildSrcSet("/x?v=1", ["hero"])).toBe("/x?v=1&variant=hero 1600w");
  });
});

describe("variantSrc", () => {
  it("appends a single bounded &variant= when the base URL already has a query", () => {
    expect(variantSrc("/api/invite/s/image/hero?v=123", "hero-bg")).toBe(
      "/api/invite/s/image/hero?v=123&variant=hero-bg",
    );
  });

  it("uses ? when the base URL has no query", () => {
    expect(variantSrc("/img", "hero-bg")).toBe("/img?variant=hero-bg");
  });
});

const EMPTY_THEME = {
  headingFont: null,
  bodyFont: null,
  hero: { accentColor: null, surfaceColor: null },
  story: { accentColor: null, surfaceColor: null },
  details: { accentColor: null, surfaceColor: null },
} as const;

describe("InviteHeader render", () => {
  it("requests the blurred hero-bg backdrop variant for the hero image (T-M2)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: null, subtitle: null, imageUrl: "/api/invite/s/image/hero?v=123" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      theme: EMPTY_THEME,
    };
    // Keep the build-time data: a failed revalidation must not wipe the hero.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => {
      const img = container.querySelector("section img");
      expect(img).not.toBeNull();
    });
    const img = container.querySelector("section img") as HTMLImageElement;
    // The hero backdrop requests the single blurred `hero-bg` variant — the blur
    // radius is a server constant keyed off the variant name, never sent here.
    expect(img.getAttribute("src")).toBe(
      "https://api.test/api/invite/s/image/hero?v=123&variant=hero-bg",
    );
    expect(img.getAttribute("sizes")).toBe("100vw");
  });

  it("starts the hero backdrop hidden, then fades it in on load", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: "/api/invite/s/image/hero?v=1" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    let img!: HTMLImageElement;
    await waitFor(() => {
      img = container.querySelector("section img") as HTMLImageElement;
      expect(img).not.toBeNull();
    });
    // Pending: invisible until the load event resolves.
    expect(img.style.opacity).toBe("0");

    img.dispatchEvent(new Event("load"));
    await waitFor(() => expect(img.style.opacity).toBe("1"));
  });

  it("drops the hero backdrop on a failed load so the gradient shows (T-M3)", async () => {
    // The old single-`onLoad` gate had no failure path, leaving a permanently
    // invisible 0-opacity <img> over the gradient. On error we now UNMOUNT it.
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: "/api/invite/s/image/hero?v=404" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    let img!: HTMLImageElement;
    await waitFor(() => {
      img = container.querySelector("section img") as HTMLImageElement;
      expect(img).not.toBeNull();
    });

    img.dispatchEvent(new Event("error"));

    // After an error the <img> is removed; the gradient base layer remains, and
    // the title is still rendered (the hero never goes blank).
    await waitFor(() => expect(container.querySelector("section img")).toBeNull());
    expect(container.querySelector("section")).not.toBeNull();
  });

  it("applies a validated theme accent as a CSS variable on the hero section", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      theme: { ...EMPTY_THEME, hero: { accentColor: "#d4af37", surfaceColor: null } },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => {
      const section = container.querySelector("section") as HTMLElement;
      expect(section.style.getPropertyValue("--invite-accent")).toBe("#d4af37");
    });
  });

  it("ignores a malicious theme colour (never reaches the DOM)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      theme: {
        ...EMPTY_THEME,
        hero: { accentColor: "red;background:url(https://evil.example)", surfaceColor: null },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => {
      expect(container.querySelector("section")).not.toBeNull();
    });
    const section = container.querySelector("section") as HTMLElement;
    expect(section.style.getPropertyValue("--invite-accent")).toBe("");
  });
});
