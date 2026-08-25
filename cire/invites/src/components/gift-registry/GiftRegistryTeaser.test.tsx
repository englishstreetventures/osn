// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GIFT_REGISTRY_EYEBROW,
  DEFAULT_GIFT_REGISTRY_HEADING,
  type GiftRegistry,
  type GiftRegistryItem,
} from "../../lib/gift-registry";
import { noteClaimed } from "../claim-session";
import { GiftRegistryTeaser } from "./GiftRegistryTeaser";

/**
 * The band the gift list leaves behind on the invite.
 *
 * What is load-bearing here:
 *   - it renders NOTHING for a visitor who has not entered their code, and
 *     nothing for a wedding with no published list — while still shipping an
 *     element child so `client:visible` can hydrate it at all;
 *   - it appears the moment a claim lands in the other island, with no reload;
 *   - it links to the list's own page, at the encoded slug;
 *   - the peek shows real gifts (never empty frames), and the fourth tile is
 *     laid out only where a fourth fits;
 *   - the availability line is quantities, never names.
 */

const API = "https://api.test";
const SLUG = "anita-and-ben";

function item(overrides: Partial<GiftRegistryItem> = {}): GiftRegistryItem {
  return {
    id: "gi-1",
    kind: "product",
    title: "Copper pan",
    description: null,
    imageName: null,
    imageCrop: null,
    externalUrl: null,
    priceMinor: null,
    quantityWanted: 2,
    quantityClaimed: 1,
    category: null,
    sortOrder: 0,
    ...overrides,
  };
}

function registry(overrides: Partial<GiftRegistry> = {}): GiftRegistry {
  return {
    headline: null,
    message: null,
    cashGiftsEnabled: false,
    currency: "AUD",
    items: [item()],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(...responses: Response[]) {
  const queue = [...responses];
  const calls: RequestInit[] = [];
  const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return (next as Response).clone();
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return Object.assign(mock, { calls });
}

function renderTeaser(props: Partial<Parameters<typeof GiftRegistryTeaser>[0]> = {}) {
  return render(() => <GiftRegistryTeaser apiUrl={API} slug={SLUG} {...props} />);
}

/** This browser has claimed here before — the band's ordinary state. */
function setClaimedHint() {
  document.cookie = "cire_claimed=1; Path=/";
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  setClaimedHint();
});

afterEach(() => {
  cleanup();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("what renders at all", () => {
  it("renders nothing for a visitor who has not entered their code, and asks nothing", async () => {
    // The list is for the couple's guests, so the band advertising it is too —
    // the same silence every other claim-gated section of the invitation keeps,
    // rather than a link to a page they cannot open.
    //
    // AND IT COSTS NOTHING (P-W1). Without the hint the read could only ever
    // 401, and this band sits on a PUBLIC invite every visitor scrolls past, so
    // an unconditional call would spend an account-wide Worker request per page
    // view to render nothing.
    document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    const mock = stubFetch(json(registry()));
    const { container } = renderTeaser();

    await Promise.resolve();
    expect(mock).not.toHaveBeenCalled();
    expect(container.querySelector("[data-gift-teaser]")).toBeNull();
  });

  it("renders nothing when a claimed guest's session has since lapsed", async () => {
    const mock = stubFetch(json({ error: "Unauthorized" }, 401));
    const { container } = renderTeaser();
    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(container.querySelector("[data-gift-teaser]")).toBeNull();
    // And the read carried the cookie, or it could only ever be a 401.
    expect(mock.calls[0]?.credentials).toBe("include");
  });

  it("appears the moment a claim lands in the other island, with no reload", async () => {
    document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    const mock = stubFetch(json(registry()));
    const { container } = renderTeaser();
    await Promise.resolve();
    expect(container.querySelector("[data-gift-teaser]")).toBeNull();
    expect(mock).not.toHaveBeenCalled();

    // Exactly what `InvitePage` does the moment a claim lands. `noteClaimed`
    // sets the hint BEFORE dispatching, which is what makes the re-read find a
    // session — and without this the band the couple wrote would stay missing
    // for the rest of the visit.
    noteClaimed();

    await screen.findByRole("link", { name: "See the gift list" });
  });

  it("renders nothing for a wedding whose list is unpublished, unentitled or absent", async () => {
    stubFetch(json({ error: "registry_not_found" }, 404));
    const { container } = renderTeaser();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector("[data-gift-teaser]")).toBeNull();
  });

  it("keeps a band that is already reading when a later read fails", async () => {
    // The three-way branch in `load()` exists for this: a guest on a phone in a
    // shop who loses signal must not watch the couple's gift band vanish from
    // an invitation that is otherwise intact — indistinguishable, to them, from
    // a wedding that never had a list.
    stubFetch(json(registry()), json({}, 500));
    const { container } = renderTeaser();
    await screen.findByRole("link", { name: "See the gift list" });

    noteClaimed(); // forces the re-read
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));

    expect(container.querySelector("[data-gift-teaser]")).toBeTruthy();
  });

  it("renders nothing when the read fails outright", async () => {
    stubFetch(json({}, 500));
    const { container } = renderTeaser();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector("[data-gift-teaser]")).toBeNull();
  });

  /**
   * HYDRATION GUARD, not a cosmetic one. `client:visible` observes the island's
   * element CHILDREN — astro's `visible.js` ends `for (const child of el.children)
   * io.observe(child)`, because `<astro-island>` is `display: contents` and owns
   * no box. A component whose whole tree hangs off a `<Show>` that is false until
   * a post-hydration fetch SSRs to nothing, hands the observer an empty list, and
   * never hydrates at all — the band simply missing from both design packs in
   * production, with every unit test still green.
   */
  it("always renders an element child, whatever the read says", async () => {
    stubFetch(json({ error: "registry_not_found" }, 404));
    const { container } = renderTeaser();
    // Before the read answers — which is the state the server renders.
    expect(container.firstElementChild).not.toBeNull();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector("[data-gift-teaser]")).toBeNull();
    expect(container.firstElementChild).not.toBeNull();
  });
});

describe("the link to the list", () => {
  it("points at the wedding's own gift page", async () => {
    stubFetch(json(registry()));
    renderTeaser();
    const link = await screen.findByRole("link", { name: "See the gift list" });
    expect(link.getAttribute("href")).toBe(`/${SLUG}/registry`);
  });

  it("encodes a slug that needs it", async () => {
    stubFetch(json(registry()));
    renderTeaser({ slug: "anita & ben" });
    const link = await screen.findByRole("link", { name: "See the gift list" });
    expect(link.getAttribute("href")).toBe("/anita%20%26%20ben/registry");
  });
});

describe("the copy", () => {
  it("falls back to built-in copy, then the module's own, then the invite's", async () => {
    stubFetch(json(registry()));
    const first = renderTeaser();
    await screen.findByText(DEFAULT_GIFT_REGISTRY_HEADING);
    expect(screen.getByText(DEFAULT_GIFT_REGISTRY_EYEBROW)).toBeTruthy();
    first.unmount();
    cleanup();

    stubFetch(json(registry({ headline: "Our List", message: "No obligation." })));
    const second = renderTeaser();
    await screen.findByText("Our List");
    expect(screen.getByText("No obligation.")).toBeTruthy();
    second.unmount();
    cleanup();

    stubFetch(json(registry({ headline: "Our List" })));
    renderTeaser({ heading: "Gifts", eyebrow: "Thank You" });
    // The invite's own section copy wins — it is section furniture, themed with
    // every other section header.
    await screen.findByText("Gifts");
    expect(screen.getByText("Thank You")).toBeTruthy();
  });

  it("summarises the list in quantities and names no one", async () => {
    stubFetch(json(registry({ items: [item({ quantityWanted: 6, quantityClaimed: 2 })] })));
    const { container } = renderTeaser();
    await waitFor(() =>
      expect(container.querySelector("[data-gift-teaser-availability]")?.textContent).toBe(
        "4 of 6 still available",
      ),
    );
    expect(container.textContent).not.toMatch(/reserved by|claimed by/i);
  });
});

describe("the peek", () => {
  it("shows the gifts that have a picture, in the couple's order, four at most", async () => {
    const items = [
      item({ id: "a", imageName: "registry-a", sortOrder: 0 }),
      item({ id: "b", imageName: null, sortOrder: 1 }),
      item({ id: "c", imageName: "registry-c", sortOrder: 2 }),
      item({ id: "d", imageName: "registry-d", sortOrder: 3 }),
      item({ id: "e", imageName: "registry-e", sortOrder: 4 }),
      item({ id: "f", imageName: "registry-f", sortOrder: 5 }),
    ];
    stubFetch(json(registry({ items })));
    const { container } = renderTeaser();

    await waitFor(() => expect(container.querySelector("[data-gift-teaser-preview]")).toBeTruthy());
    const tiles = [...container.querySelectorAll("[data-gift-teaser-preview] img")];
    expect(tiles).toHaveLength(4);
    // The pictureless gift is skipped rather than drawn as an empty frame.
    expect(tiles[1]?.getAttribute("src")).toContain("registry-c");
    // The fourth is laid out only where a fourth fits, rather than wrapping
    // alone onto a second row.
    const fourth = container.querySelectorAll("[data-gift-teaser-preview] li")[3];
    expect(fourth?.getAttribute("class")).toContain("hidden md:block");
  });

  it("skips the row entirely when no gift has a picture", async () => {
    stubFetch(json(registry()));
    const { container } = renderTeaser();
    await screen.findByRole("link", { name: "See the gift list" });
    expect(container.querySelector("[data-gift-teaser-preview]")).toBeNull();
  });
});
