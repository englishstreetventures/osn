import { derivePalette, PALETTE_PRESETS } from "@cire/theme";
import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, vi, afterEach } from "vitest";

import { setReturningHousehold } from "../../../src/components/returning-household";
import InviteHeader from "../../../src/designs/classic/InviteHeader";
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

describe("InviteHeader render", () => {
  it("requests the blurred hero-bg backdrop variant for the hero image (T-M2)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: null, subtitle: null, imageUrl: "/api/invite/s/image/hero?v=123" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    // With the route's payload in `initial` the header fetches nothing; the
    // failing stub keeps any stray request off the network.
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
    // Pending: invisible until the load event resolves. (Visibility moved from
    // an inline style to breakpoint-aware classes with the 0046 phone crop.)
    expect(img.className).toContain("opacity-0");

    img.dispatchEvent(new Event("load"));
    // Loaded, no crops ⇒ visible at every breakpoint.
    await waitFor(() => expect(img.className).toContain("opacity-100"));
  });

  it("renders per-breakpoint crop layers: desktop from md: up, the phone crop below (0046)", async () => {
    const initial: InviteCustomisation = {
      hero: {
        title: "A & B",
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
        title: "A & B",
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

  it("drops the hero backdrop on a failed load so the gradient shows (T-M3)", async () => {
    // The old single-`onLoad` gate had no failure path, leaving a permanently
    // invisible 0-opacity <img> over the gradient. On error we now UNMOUNT it.
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: "/api/invite/s/image/hero?v=404" },
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
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: { ...EMPTY_THEME, palette: { gilt: "#d4af37" }, tones: { hero: "card" } },
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
      // The hero picks its surface from the tone…
      expect(section.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-surface)");
    });
    // …and the accent reaches it via the root palette, which is what finally
    // makes the hero's `text-gold` utilities follow the organiser's scheme —
    // they were stuck on the built-in gold before the palette landed.
    expect(document.documentElement.style.getPropertyValue("--color-gold")).toBe(
      derivePalette({ gilt: "#d4af37" })["--color-gold"],
    );
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

  it("renders NOTHING for the hero when it has no image, title or subtitle", async () => {
    // A fully-empty hero must not paint an empty full-screen section. The story
    // is also empty here, so the whole component renders no <section> at all.
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

    // Let the render settle.
    await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeNull());
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows a title-only hero (no image, no subtitle)", async () => {
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

    const { container, getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => expect(getByText("A & B")).toBeTruthy());
    // Exactly the hero section renders (the empty story stays hidden).
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("shows an image-only hero (no title, no subtitle)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: null, subtitle: null, imageUrl: "/api/invite/s/image/hero?v=1" },
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

    await waitFor(() => expect(container.querySelector("section img")).not.toBeNull());
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("falls back to the neutral 'You're Invited' hero title (never a bespoke monogram)", async () => {
    // A shown hero with no couple title must render neutral fallback copy — a
    // multi-tenant product can't default to one couple's initials ("V & R").
    const initial: InviteCustomisation = {
      hero: { title: null, subtitle: null, imageUrl: "/api/invite/s/image/hero?v=1" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { getByText, queryByText, container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => expect(getByText("You're Invited")).toBeTruthy());
    expect(queryByText("V")).toBeNull();
    expect(queryByText("R")).toBeNull();
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("falls back to neutral story copy (never the bespoke couple's story)", async () => {
    // A shown story with no body (heading-only) renders the neutral fallback.
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: "How It Began", body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { getByText, queryByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => expect(getByText(/Every love story is beautiful/)).toBeTruthy());
    expect(queryByText(/three and a half years/)).toBeNull();
    expect(queryByText(/Rox/)).toBeNull();
  });

  it("hides the Our Story section when heading, body and image are all empty", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      // Eyebrow alone does NOT keep the story alive.
      story: { eyebrow: "Our Story", heading: "  ", body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container, queryByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => expect(container.querySelector("section")).not.toBeNull());
    // Only the hero renders; the default "How It All Began" story copy is absent.
    expect(container.querySelectorAll("section")).toHaveLength(1);
    expect(queryByText("How It All Began")).toBeNull();
  });

  it("shows the Our Story section when it has a body", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: "We met long ago.", imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container, getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => expect(getByText("We met long ago.")).toBeTruthy());
    // Hero + story both render.
    expect(container.querySelectorAll("section")).toHaveLength(2);
  });

  it("ignores a malicious theme colour (never reaches the DOM)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: {
        ...EMPTY_THEME,
        palette: { gilt: "red;background:url(https://evil.example)" },
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
    // No tone ⇒ the hero sits on the page ground, exactly as before…
    expect(section.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-bg)");
    // …and the malicious seed is dropped at the render boundary, so the accent
    // stays the built-in gold rather than reaching the rendered CSS.
    expect(document.documentElement.style.getPropertyValue("--color-gold")).toBe(
      derivePalette(PALETTE_PRESETS.evergreen)["--color-gold"],
    );
  });

  // ── SSR-hydration visibility fix ──────────────────────────────────────────

  it("reveals the hero when the image is ALREADY complete on hydrate (SSR race)", async () => {
    // On an SSR page the browser can finish loading the server-rendered <img>
    // BEFORE the island hydrates, so the `load` event never reaches onLoad. The
    // ref check in onMount must catch this `complete && naturalWidth > 0` case
    // and reveal the image — otherwise it stays at opacity 0 forever (the live
    // bug). Force both getters true so the mount check sees an already-loaded img.
    const completeSpy = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    const widthSpy = vi
      .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
      .mockReturnValue(1600);

    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: "/api/invite/s/image/hero?v=1" },
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

    // No `load` event is ever dispatched here — the only way it becomes visible
    // is the onMount complete-check.
    await waitFor(() => {
      const img = container.querySelector("section img") as HTMLImageElement;
      expect(img?.className).toContain("opacity-100");
    });

    completeSpy.mockRestore();
    widthSpy.mockRestore();
  });

  it("does NOT hide an already-shown hero when new data carries the same url", async () => {
    // Astro reconciles an island's props, so the header can receive a NEW
    // customisation object whose hero url is unchanged. The re-arm effect must
    // NOT reset a shown image back to pending (opacity 0): the <img src> is
    // unchanged, so the browser would never re-fire `load` and it would be stuck
    // invisible.
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: "/api/invite/s/image/hero?v=1" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    const [current, setCurrent] = createSignal(initial);

    const { container, getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={current()} />
    ));

    let img!: HTMLImageElement;
    await waitFor(() => {
      img = container.querySelector("section img") as HTMLImageElement;
      expect(img).not.toBeNull();
    });
    // Load it (the not-yet-loaded path).
    img.dispatchEvent(new Event("load"));
    await waitFor(() => expect(img.className).toContain("opacity-100"));

    // A new object, same hero url, different title — the title proves the new
    // data rendered, and the image must still be visible.
    setCurrent({ ...initial, hero: { ...initial.hero, title: "C & D" } });
    await waitFor(() => expect(getByText("C & D")).toBeTruthy());
    expect((container.querySelector("section img") as HTMLImageElement).className).toContain(
      "opacity-100",
    );
  });

  // ── Feature 1: hero backdrop always requests hero-bg (server applies blur) ──

  it("always requests the hero-bg variant — the blur is applied server-side (0018)", async () => {
    // The per-wedding blur (incl. 0 ⇒ sharp) lives on the row and is applied by
    // the server to the hero-bg transform, so the guest always asks for hero-bg
    // regardless of the blur value — no client variant switch.
    const initial: InviteCustomisation = {
      hero: { title: null, subtitle: null, imageUrl: "/api/invite/s/image/hero?v=9" },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: { blur: 0, titleBackdrop: { opacity: 0, blur: 0 } },
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { container } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    await waitFor(() => expect(container.querySelector("section img")).not.toBeNull());
    const img = container.querySelector("section img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      "https://api.test/api/invite/s/image/hero?v=9&variant=hero-bg",
    );
  });

  it("fetches nothing when the route's payload is in `initial`", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(initial)));
    vi.stubGlobal("fetch", fetchMock);

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    expect(getByText("A & B")).toBeTruthy();
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

  // ── Feature 2: hero title backdrop sliders (opacity + blur) ────────────────

  it("renders the title legibility panel when opacity > 0, with a frosted blur (Feature 2)", async () => {
    const initial: InviteCustomisation = {
      hero: { title: "A & B", subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: { blur: 28, titleBackdrop: { opacity: 60, blur: 8 } },
      theme: EMPTY_THEME,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const title = await waitFor(() => getByText("A & B"));
    // The wrapper panel carries a background (opacity-driven) AND a backdrop-filter
    // blur. With opacity 0 it has neither.
    const panel = title.parentElement as HTMLElement;
    expect(panel.style.getPropertyValue("background-color")).toContain("60%");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("blur(8px)");
    // NB: the component also emits the Safari-prefixed `-webkit-backdrop-filter`
    // twin, but happy-dom drops the vendor-prefixed property from the inline
    // style attribute, so it can't be asserted here — verified by the source.
  });

  it("renders NO title panel by default (titleBackdrop opacity 0)", async () => {
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

    const { getByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={initial} />
    ));

    const title = await waitFor(() => getByText("A & B"));
    const panel = title.parentElement as HTMLElement;
    expect(panel.style.getPropertyValue("background-color")).toBe("");
    expect(panel.style.getPropertyValue("backdrop-filter")).toBe("");
  });
});

describe("classic InviteHeader visibility switches (migration 0063)", () => {
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

describe("classic InviteHeader fallback title for a returning household", () => {
  afterEach(() => {
    setReturningHousehold(false);
  });

  function hero(title: string | null): InviteCustomisation {
    return {
      hero: { title, subtitle: "Lisbon · 12 June", imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      heroDisplay: DEFAULT_HERO_DISPLAY,
      theme: EMPTY_THEME,
    };
  }

  it("welcomes back the household the panel found, and goes back once it signs out", async () => {
    const { getByText, queryByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={hero(null)} />
    ));
    expect(getByText("You're Invited")).toBeTruthy();

    // The welcome panel is another island; it publishes what it found.
    setReturningHousehold(true);
    await waitFor(() => expect(getByText("Welcome back to your invite")).toBeTruthy());
    expect(queryByText("You're Invited")).toBeNull();

    setReturningHousehold(false);
    await waitFor(() => expect(getByText("You're Invited")).toBeTruthy());
    expect(queryByText("Welcome back to your invite")).toBeNull();
  });

  it("never replaces the couple's own title", () => {
    setReturningHousehold(true);
    const { getByText, queryByText } = render(() => (
      <InviteHeader apiUrl="https://api.test" slug="s" initial={hero("Anita & Ben")} />
    ));
    expect(getByText("Anita & Ben")).toBeTruthy();
    expect(queryByText("Welcome back to your invite")).toBeNull();
  });
});
