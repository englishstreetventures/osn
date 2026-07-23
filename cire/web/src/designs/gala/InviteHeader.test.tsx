import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import type { InviteCustomisation } from "../types";
import InviteHeader from "./InviteHeader";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EMPTY_THEME = {
  headingFont: null,
  bodyFont: null,
  palette: null,
  tones: null,
} as const;

// Today's-look hero display defaults — every fixture spreads this unless a test
// is specifically exercising a non-default option.
const DEFAULT_HERO_DISPLAY = { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } } as const;

describe("gala InviteHeader render", () => {
  it("renders the hero title from `initial` (SSR-painted, no fetch wait)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    // The build-time `initial` prop paints synchronously; the fetch below is the
    // on-mount revalidation, kept failing so it never overwrites the assertion.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    expect(getByText("Anita & Ben")).toBeTruthy();
  });

  it("renders NOTHING for the hero when isHeroEmpty (no image, title or subtitle)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: null, subtitle: "   ", imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    // Both hero and story are empty here, so no <section> renders at all.
    await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeNull());
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders per-breakpoint crop layers: desktop from md: up, the phone crop below (0046)", async () => {
    const initial: InviteCustomisation = {
      hero: {
        title: "Anita & Ben",
        subtitle: null,
        imageUrl: "/api/invite/s/image/hero?v=1",
        // Desktop focal centre (50%, 30%); phone focal centre (75%, 45%).
        imageCrop: { x: 0.25, y: 0.1, w: 0.5, h: 0.4 },
        imageCropMobile: { x: 0.6, y: 0, w: 0.3, h: 0.9 },
      },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
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
    img.dispatchEvent(new Event("load"));

    // The wide layer (hidden below md:) carries the desktop focal point; the
    // narrow layer (md:hidden) carries the phone one. Both cover-render the same
    // hero-bg source.
    const wide = container.querySelector("section div.md\\:block") as HTMLDivElement;
    const narrow = container.querySelector("section div.md\\:hidden") as HTMLDivElement;
    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    expect(wide.className).toContain("hidden");
    expect(wide.style.backgroundPosition).toBe("50% 30%");
    expect(narrow.style.backgroundPosition).toBe("75% 45%");
    expect(wide.style.backgroundImage).toContain("variant=hero-bg");
    expect(narrow.style.backgroundImage).toContain("variant=hero-bg");
    // With a wide layer present every breakpoint is covered — the plain <img>
    // stays hidden everywhere, even once loaded.
    await waitFor(() => expect(img.className).toContain("opacity-0"));
  });

  it("a desktop-only crop covers every breakpoint (narrow falls back — pre-0046 render)", async () => {
    const initial: InviteCustomisation = {
      hero: {
        title: "Anita & Ben",
        subtitle: null,
        imageUrl: "/api/invite/s/image/hero?v=1",
        imageCrop: { x: 0.25, y: 0.1, w: 0.5, h: 0.4 },
        imageCropMobile: null,
      },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => {
      expect(container.querySelector("section img")).not.toBeNull();
    });
    // Both layers render, both carrying the SAME desktop focal point — narrow
    // viewports keep the single-crop behaviour they had before the phone crop.
    const wide = container.querySelector("section div.md\\:block") as HTMLDivElement;
    const narrow = container.querySelector("section div.md\\:hidden") as HTMLDivElement;
    expect(wide.style.backgroundPosition).toBe("50% 30%");
    expect(narrow.style.backgroundPosition).toBe("50% 30%");
  });

  it("renders the story image WITHOUT a `hidden` class (visible on mobile, unlike classic)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
      story: {
        eyebrow: null,
        heading: null,
        body: "We met long ago.",
        imageUrl: "/api/invite/s/image/story?v=1",
      },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    // The story <img> is identified by its lazy-loading attribute (unique to the
    // story photo path — the hero backdrop is eager).
    let img!: HTMLImageElement;
    await waitFor(() => {
      img = container.querySelector('img[loading="lazy"]') as HTMLImageElement;
      expect(img).not.toBeNull();
    });
    expect(img.classList.contains("hidden")).toBe(false);
    // Nor does classic's exact `hidden md:block` mobile-hiding pattern appear
    // anywhere in the story section's markup.
    const storySection = img.closest("section") as HTMLElement;
    expect(storySection.innerHTML).not.toMatch(/\bhidden md:block\b/);
  });

  it("revalidates on mount with a single no-store fetch", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(initial), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(() => <InviteHeader apiUrl="https://api.test" slug="my-slug" initial={initial} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/invite/my-slug",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("keeps the painted title when the revalidate fetch fails", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    // Immediately painted from `initial`, and still there once the failed
    // revalidation settles (falls back to `props.initial`, not null).
    expect(getByText("Anita & Ben")).toBeTruthy();
    await waitFor(() => expect(getByText("Anita & Ben")).toBeTruthy());
  });
});
