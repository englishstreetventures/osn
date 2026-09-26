import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import InviteHeader from "../../../src/designs/gala/InviteHeader";
import type { InviteCustomisation } from "../../../src/designs/types";

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
    // The route's payload in `initial` paints synchronously and the header
    // fetches nothing; the failing stub keeps any stray request off the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    expect(getByText("Anita & Ben")).toBeTruthy();
  });

  it("hero title consumes the typography variables with pack-literal fallbacks (T-S1)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
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

    // The organiser's heading options reach the guest only through these var()
    // references (0048) — a refactor back to `font-light`/`italic` literals or
    // a typo'd var name silently kills the feature while everything else stays
    // green, so pin the class contract here. happy-dom can't compute the
    // calc(clamp()*var()) value, so assert the references, not resolved pixels.
    await waitFor(() => {
      const title = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "A & B",
      );
      expect(title).toBeDefined();
      expect(title!.className).toContain("[font-weight:var(--invite-heading-weight,300)]");
      expect(title!.className).toContain("[font-style:var(--invite-heading-style,normal)]");
      expect(title!.className).toContain("*var(--invite-heading-scale,1))]");
    });
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

  it("fetches nothing when the route's payload is in `initial`", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(initial)));
    vi.stubGlobal("fetch", fetchMock);

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="my-slug" initial={initial} />
    ));

    expect(getByText("Anita & Ben")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once from the browser, no-store, and paints the result when the route had no payload", async () => {
    const live: InviteCustomisation = {
      hero: { title: "New Name", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(live), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="my-slug" initial={null} />
    ));

    await waitFor(() => expect(getByText("New Name")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/invite/my-slug",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("keeps the built-in defaults when the retry returns a non-OK status", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ hero: { title: "Error Body" } }), { status: 500 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container, queryByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={null} />
    ));

    // Nothing is painted before the retry settles either, so the assertion only
    // means something once it has: the macrotask below drains the promise chain
    // behind the fetch. The success test above is the twin that shows a body
    // does land by this point when it should.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryByText("Error Body")).toBeNull();
    expect(container.querySelector("section")).toBeNull();
  });

  it("keeps the built-in defaults when the retry throws", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={null} />
    ));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector("section")).toBeNull();
  });

  // ── Hero title backdrop sliders (opacity + blur) ───────────────────────────
  // Gala's equivalents of classic's two panel cases, plus the clamp neither
  // pack covered: `clampNum` (designs/gala/InviteHeader.tsx) bounds opacity to
  // [0,100] and blur to [0,20] and drops a non-number to the default, against a
  // stale or garbage payload.

  const offline = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

  /** The legibility panel is the title span's wrapper — no panel ⇒ no styles. */
  const panelFor = (title: HTMLElement) => title.parentElement as HTMLElement;

  it("renders the title legibility panel when opacity > 0, with a frosted blur", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: { blur: 28, titleBackdrop: { opacity: 60, blur: 8 } },
      theme: EMPTY_THEME,
    };
    offline();

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const panel = panelFor(await waitFor(() => getByText("A & B")));
    expect(panel.style.getPropertyValue("background-color")).toContain("60%");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("blur(8px)");
    // The component emits the Safari-prefixed `-webkit-backdrop-filter` twin as
    // well, but jsdom drops a vendor-prefixed property from the inline style
    // attribute, so it cannot be asserted here.
  });

  it("renders NO title panel by default (titleBackdrop opacity 0)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    offline();

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const panel = panelFor(await waitFor(() => getByText("A & B")));
    expect(panel.style.getPropertyValue("background-color")).toBe("");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("");
  });

  it("pins an over-range opacity to 100% and an over-range blur to 20px", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: { blur: 28, titleBackdrop: { opacity: 500, blur: 99 } },
      theme: EMPTY_THEME,
    };
    offline();

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const panel = panelFor(await waitFor(() => getByText("A & B")));
    expect(panel.style.getPropertyValue("background-color")).toContain("100%");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("blur(20px)");
  });

  it("drops a non-numeric opacity to the default, so no panel renders", async () => {
    // The fixture is the NUMERIC STRING "60", not "abc": a garbage word compares
    // `> 0` as false, so a pass-through (clamp deleted) would render no panel
    // either and the test could not fail. "60" renders a 60% panel without the
    // clamp and nothing with it.
    const initial = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: { blur: 28, titleBackdrop: { opacity: "60", blur: 0 } },
      theme: EMPTY_THEME,
    } as unknown as InviteCustomisation;
    offline();

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const panel = panelFor(await waitFor(() => getByText("A & B")));
    expect(panel.style.getPropertyValue("background-color")).toBe("");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("");
  });

  it("drops a non-numeric blur to the default, keeping the panel unfrosted", async () => {
    // Opacity has to be valid, or the style block is never emitted and the blur
    // assertion would pass with any clamp at all. "8" is a numeric string for
    // the same reason as above.
    const initial = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: { blur: 28, titleBackdrop: { opacity: 60, blur: "8" } },
      theme: EMPTY_THEME,
    } as unknown as InviteCustomisation;
    offline();

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const panel = panelFor(await waitFor(() => getByText("A & B")));
    expect(panel.style.getPropertyValue("background-color")).toContain("60%");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("blur(0px)");
  });
});

describe("gala InviteHeader visibility switches (migration 0063)", () => {
  const FILLED: InviteCustomisation = {
    hero: { title: "A & B", subtitle: "Save the date", imageUrl: null },
    story: { eyebrow: null, heading: "How It Began", body: "We met long ago.", imageUrl: null },
    heroDisplay: DEFAULT_HERO_DISPLAY,
    theme: EMPTY_THEME,
  };

  function renderHeader(initial: InviteCustomisation) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    return render(() => <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />);
  }

  it("shows both sections when switched on and filled", async () => {
    const { container, getByText } = renderHeader({
      ...FILLED,
      visibility: { hero: true, story: true },
    });
    await waitFor(() => expect(getByText("We met long ago.")).toBeTruthy());
    expect(container.querySelectorAll("section")).toHaveLength(2);
  });

  it("hides a switched-off hero that has content, and keeps the story", async () => {
    const { container, getByText, queryByText } = renderHeader({
      ...FILLED,
      visibility: { hero: false, story: true },
    });
    await waitFor(() => expect(getByText("We met long ago.")).toBeTruthy());
    expect(queryByText("Save the date")).toBeNull();
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("hides a switched-off story that has content, and keeps the hero", async () => {
    const { container, getByText, queryByText } = renderHeader({
      ...FILLED,
      visibility: { hero: true, story: false },
    });
    await waitFor(() => expect(getByText("Save the date")).toBeTruthy());
    expect(queryByText("We met long ago.")).toBeNull();
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("renders nothing for sections switched on but empty", async () => {
    const { container } = renderHeader({
      hero: { title: null, subtitle: "  ", imageUrl: null },
      story: { eyebrow: "Our Story", heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
      visibility: { hero: true, story: true },
    });
    await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeNull());
    expect(container.querySelector("section")).toBeNull();
  });
});
