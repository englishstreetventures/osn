// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GiftRegistry, GiftRegistryItem } from "../../lib/gift-registry";
import { noteClaimed, signOut } from "../claim-session";
import {
  DEFAULT_GIFT_REGISTRY_EYEBROW,
  DEFAULT_GIFT_REGISTRY_HEADING,
  giftRegistryWriteMessage,
  GiftRegistrySection,
} from "./GiftRegistrySection";

/**
 * The guest-facing gift registry as a whole.
 *
 * What is asserted here is what the spec calls load-bearing:
 *   - counts reach the DOM, claimant identities never do;
 *   - the 409 race refetches and TELLS the guest, and is never painted as a
 *     success that did not happen;
 *   - a signed-out visitor sees the list and a prompt, not a dead button, and
 *     costs the credentialed route nothing;
 *   - a shipping address renders only when the API actually sent one;
 *   - an unpublished registry (404) renders no section at all, which is a
 *     different thing from a published registry with no items.
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

/**
 * A fetch stub routed by URL, so a test states what each ROUTE answers instead
 * of counting calls in mount order. Queued answers pop in order; the last one
 * repeats, which is what makes the "refetch after a 409" tests readable.
 */
function routedFetch(routes: {
  list?: Response[];
  mine?: Response[];
  claim?: Response[];
  release?: Response[];
}) {
  const queues = {
    list: [...(routes.list ?? [json({ error: "registry_not_found" }, 404)])],
    mine: [...(routes.mine ?? [json({ error: "unauthorised" }, 401)])],
    claim: [...(routes.claim ?? [json({ ok: true })])],
    release: [...(routes.release ?? [json({ ok: true })])],
  };
  const calls: { url: string; method: string }[] = [];

  const take = (key: keyof typeof queues) => {
    const queue = queues[key];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return (next as Response).clone();
  };

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/claim")) return take(method === "DELETE" ? "release" : "claim");
    if (url.endsWith("/registry/mine")) return take("mine");
    return take("list");
  });

  globalThis.fetch = mock as unknown as typeof fetch;
  return { mock, calls };
}

function renderSection(props: Partial<Parameters<typeof GiftRegistrySection>[0]> = {}) {
  return render(() => <GiftRegistrySection apiUrl={API} slug={SLUG} {...props} />);
}

/** Pretend this browser has claimed before, which is what gates the /mine read. */
function setClaimedHint() {
  document.cookie = "cire_claimed=1; Path=/";
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("what renders at all", () => {
  it("renders nothing for a registry that is unpublished or unentitled (404)", async () => {
    routedFetch({ list: [json({ error: "registry_not_found" }, 404)] });
    const { container } = renderSection();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector("[data-gift-registry]")).toBeNull();
  });

  /**
   * HYDRATION GUARD, not a cosmetic one. `client:visible` observes the island's
   * element CHILDREN — astro's `visible.js` ends `for (const child of el.children)
   * io.observe(child)`, because `<astro-island>` is `display: contents` and owns
   * no box. A component whose whole tree hangs off a `<Show>` that is false until
   * a post-hydration fetch SSRs to nothing, hands the observer an empty list, and
   * never hydrates at all — the section simply missing from both design packs in
   * production, with every unit test still green.
   */
  it("always renders an element child, whatever the registry read says", async () => {
    routedFetch({ list: [json({ error: "registry_not_found" }, 404)] });
    const { container } = renderSection();
    // Before the read answers — which is the state the server renders.
    expect(container.firstElementChild).not.toBeNull();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // And after the read says there is no registry.
    expect(container.querySelector("[data-gift-registry]")).toBeNull();
    expect(container.firstElementChild).not.toBeNull();
  });

  it("renders nothing when the list read fails outright", async () => {
    routedFetch({ list: [json({}, 500)] });
    const { container } = renderSection();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector("[data-gift-registry]")).toBeNull();
  });

  it("renders the section with its own note when a PUBLISHED registry is empty", async () => {
    routedFetch({ list: [json(registry({ items: [] }))] });
    const { container } = renderSection();
    await screen.findByText("The couple haven’t added any gifts yet.");
    expect(container.querySelector("[data-gift-registry]")).toBeTruthy();
  });

  it("falls back to built-in copy, then the module's own, then the invite's", async () => {
    routedFetch({ list: [json(registry())] });
    const { unmount } = renderSection();
    await screen.findByText(DEFAULT_GIFT_REGISTRY_HEADING);
    expect(screen.getByText(DEFAULT_GIFT_REGISTRY_EYEBROW)).toBeTruthy();
    unmount();
    cleanup();

    routedFetch({ list: [json(registry({ headline: "Our List", message: "No obligation." }))] });
    const second = renderSection();
    await screen.findByText("Our List");
    expect(screen.getByText("No obligation.")).toBeTruthy();
    second.unmount();
    cleanup();

    routedFetch({ list: [json(registry({ headline: "Our List" }))] });
    renderSection({ heading: "Gifts", eyebrow: "Thank You" });
    // The invite's own section copy wins — it is section furniture, themed with
    // every other section header.
    await screen.findByText("Gifts");
    expect(screen.getByText("Thank You")).toBeTruthy();
  });
});

describe("the privacy property", () => {
  it("puts counts in the DOM and no claimant identity anywhere", async () => {
    routedFetch({
      list: [json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 1 })] }))],
      mine: [json({ claims: [] })],
    });
    setClaimedHint();
    const { container } = renderSection();

    await screen.findByText("1 of 2 left");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/reserved by|claimed by|Ashworth/i);
    expect(container.querySelector("[data-gift-mine]")).toBeNull();
  });

  it("never asks for anything but counts on the public read", async () => {
    const { calls } = routedFetch({ list: [json(registry())] });
    renderSection();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // One public read, and no credentialed read for a browser with no hint.
    expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith("/registry/mine"))).toBe(false);
  });
});

describe("the signed-out path", () => {
  it("shows the list and a prompt to enter the invite code, not a dead button", async () => {
    routedFetch({ list: [json(registry())] });
    const { container } = renderSection();

    await screen.findByText("Enter your invite code at the top of this page to reserve a gift.");
    expect(screen.getByText("1 of 2 left")).toBeTruthy();
    // No claim/release controls exist to be pressed.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("skips the credentialed read entirely without the claim hint", async () => {
    const { calls } = routedFetch({ list: [json(registry())] });
    renderSection();
    await screen.findByText("1 of 2 left");
    expect(calls.some((c) => c.url.endsWith("/registry/mine"))).toBe(false);
  });

  /**
   * THE CROSS-ISLAND CASE. `InvitePage` owns the code form and the claim; this
   * section is a separate island, and the claim navigates nowhere — the invite is
   * revealed in place. Nothing but the event `noteClaimed()` fires can tell this
   * island that the browser just signed in, and without it the guest keeps a
   * prompt pointing at a form the reveal has already faded away.
   */
  it("notices a claim made in the other island, with no reload", async () => {
    const { calls } = routedFetch({ list: [json(registry())], mine: [json({ claims: [] })] });
    renderSection();

    await screen.findByText("Enter your invite code at the top of this page to reserve a gift.");
    expect(calls.some((c) => c.url.endsWith("/registry/mine"))).toBe(false);

    // Exactly what `InvitePage` does the moment a claim lands.
    noteClaimed();

    await screen.findByRole("button", { name: "Reserve" });
    expect(calls.some((c) => c.url.endsWith("/registry/mine"))).toBe(true);
    expect(
      screen.queryByText("Enter your invite code at the top of this page to reserve a gift."),
    ).toBeNull();
  });

  it("drops back to the prompt when the guest signs out in the other island", async () => {
    setClaimedHint();
    routedFetch({ list: [json(registry())], mine: [json({ claims: [] })] });
    const { container } = renderSection();

    await screen.findByRole("button", { name: "Reserve" });
    await signOut(API);

    await waitFor(() => expect(container.querySelectorAll("button")).toHaveLength(0));
    expect(
      screen.getByText("Enter your invite code at the top of this page to reserve a gift."),
    ).toBeTruthy();
  });

  it("reads the household when the browser has claimed before", async () => {
    setClaimedHint();
    const { calls } = routedFetch({ list: [json(registry())], mine: [json({ claims: [] })] });
    renderSection();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/registry/mine"))).toBe(true));
    await screen.findByRole("button", { name: "Reserve" });
  });
});

describe("this household's own claims", () => {
  it("merges its own claim into the list", async () => {
    setClaimedHint();
    routedFetch({
      list: [json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 1 })] }))],
      mine: [
        json({
          claims: [
            {
              itemId: "gi-1",
              quantity: 1,
              status: "reserved",
              note: null,
              displayName: "The Ashworths",
            },
          ],
        }),
      ],
    });
    const { container } = renderSection();

    await waitFor(() => expect(container.querySelector("[data-gift-mine]")).toBeTruthy());
    expect(container.querySelector("[data-gift-mine]")?.textContent).toContain("The Ashworths");
  });

  it("renders the shipping address only when the API actually sent one", async () => {
    setClaimedHint();
    routedFetch({
      list: [json(registry())],
      mine: [json({ claims: [], shippingAddress: "12 Rose Lane\nSydney" })],
    });
    const first = renderSection();
    await waitFor(() => expect(first.container.querySelector("[data-gift-shipping]")).toBeTruthy());
    expect(first.container.querySelector("[data-gift-shipping]")?.textContent).toContain(
      "12 Rose Lane",
    );
    first.unmount();
    cleanup();

    routedFetch({ list: [json(registry())], mine: [json({ claims: [] })] });
    const second = renderSection();
    await screen.findByRole("button", { name: "Reserve" });
    // Absent means "you may not see it" and "there isn't one" at once, so the
    // section says nothing at all rather than inventing a reason.
    expect(second.container.querySelector("[data-gift-shipping]")).toBeNull();
    expect(second.container.textContent).not.toContain("Send gifts to");
  });
});

describe("claiming", () => {
  it("re-reads both routes after a successful claim rather than guessing", async () => {
    setClaimedHint();
    const { calls } = routedFetch({
      list: [
        json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 0 })] })),
        json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 1 })] })),
      ],
      mine: [
        json({ claims: [] }),
        json({
          claims: [
            { itemId: "gi-1", quantity: 1, status: "reserved", note: null, displayName: null },
          ],
        }),
      ],
      claim: [json({ ok: true })],
    });
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText("Reserved. “Copper pan” is marked as yours.");
    // The counts come from the re-read, which lands after the message.
    await waitFor(() =>
      expect(container.querySelector("[data-gift-remaining]")?.textContent).toBe("1 of 2 left"),
    );
    expect(container.querySelector("[data-gift-mine]")).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith("/registry/mine"))).toHaveLength(2);
  });

  it("handles the 409 race honestly: refetched counts, a plain message, no fake success", async () => {
    setClaimedHint();
    const { calls } = routedFetch({
      list: [
        // What this guest was looking at: the last one is free.
        json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 1 })] })),
        // What is true by the time they press: another household took it.
        json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 2 })] })),
      ],
      mine: [json({ claims: [] })],
      claim: [json({ error: "item_fully_claimed" }, 409)],
    });
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(
      "Another guest reserved the last “Copper pan” a moment ago. The list below is up to date.",
    );

    // The counts beside the message came from a read that finished AFTER the
    // 409 — never an optimistic decrement, never the stale ones.
    await waitFor(() =>
      expect(container.querySelector("[data-gift-remaining]")?.textContent).toBe("All reserved"),
    );
    expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(2);
    // Nothing is claimed by us, and nothing pretends otherwise.
    expect(container.querySelector("[data-gift-mine]")).toBeNull();
    // Nothing is left to reserve either, so the form goes with it rather than
    // sitting there holding `min="1"` beside `max="0"` — a Confirm that could
    // only be refused, under a message that already said so.
    await waitFor(() => expect(container.querySelector("form")).toBeNull());
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("keeps the form open after a 409 that still leaves something to reserve", async () => {
    setClaimedHint();
    routedFetch({
      list: [
        json(registry({ items: [item({ quantityWanted: 3, quantityClaimed: 0 })] })),
        // The API also answers 409 when OTHER households' live claims exceed
        // what is left for the number asked — here two of three are taken and
        // one is still free, so the form is still worth having. This is why the
        // close must key on the CEILING and never on the 409 itself.
        json(registry({ items: [item({ quantityWanted: 3, quantityClaimed: 2 })] })),
      ],
      mine: [json({ claims: [] })],
      claim: [json({ error: "item_fully_claimed" }, 409)],
    });
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    const name = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.input(name, { target: { value: "The Ashworths" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(/Another guest reserved the last/);
    await waitFor(() =>
      expect(container.querySelector("[data-gift-remaining]")?.textContent).toBe("1 of 3 left"),
    );
    expect(container.querySelector("form")).toBeTruthy();
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(
      "The Ashworths",
    );
  });

  it("drops to the signed-out surface when the session lapsed mid-visit", async () => {
    setClaimedHint();
    routedFetch({
      list: [json(registry())],
      mine: [json({ claims: [] })],
      claim: [json({ error: "unauthorised" }, 401)],
    });
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(
      "Your invite session has ended. Enter your invite code again to reserve a gift.",
    );
    await waitFor(() => expect(container.querySelectorAll("button")).toHaveLength(0));
  });

  it("does not re-read anything when the write never reached the server", async () => {
    setClaimedHint();
    const { calls } = routedFetch({
      list: [json(registry())],
      mine: [json({ claims: [] })],
      claim: [json({ error: "rate_limited" }, 429)],
    });
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText("That was a lot of changes at once. Try again in a moment.");
    expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(1);
  });

  it("releases a claim and re-reads", async () => {
    setClaimedHint();
    const { calls } = routedFetch({
      list: [json(registry())],
      mine: [
        json({
          claims: [
            { itemId: "gi-1", quantity: 1, status: "reserved", note: null, displayName: null },
          ],
        }),
        json({ claims: [] }),
      ],
      release: [json({ ok: true })],
    });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Release" }));

    await screen.findByText("Released. “Copper pan” is free for another guest again.");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("the status line", () => {
  it("is a polite live region at the section root, not an overlay", async () => {
    routedFetch({ list: [json(registry())] });
    const { container } = renderSection();
    await screen.findByText("1 of 2 left");

    const status = container.querySelector("[data-gift-status]") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    // A `transform` on any ancestor would trap a fixed overlay; there is none.
    expect(container.querySelector(".fixed")).toBeNull();
  });
});

describe("giftRegistryWriteMessage", () => {
  it("names a duration only when the server named one", () => {
    expect(
      giftRegistryWriteMessage({ kind: "rate-limited", retryAfterSeconds: 60 }, "claim", "Pan"),
    ).toBe("That was a lot of changes at once. Try again in 60 seconds.");
    expect(
      giftRegistryWriteMessage({ kind: "rate-limited", retryAfterSeconds: null }, "claim", "Pan"),
    ).toBe("That was a lot of changes at once. Try again in a moment.");
  });

  it("has distinct copy for every outcome a guest can hit", () => {
    const messages = [
      giftRegistryWriteMessage({ kind: "ok" }, "claim", "Pan"),
      giftRegistryWriteMessage({ kind: "ok" }, "release", "Pan"),
      giftRegistryWriteMessage({ kind: "fully-claimed" }, "claim", "Pan"),
      giftRegistryWriteMessage({ kind: "item-gone" }, "claim", "Pan"),
      giftRegistryWriteMessage({ kind: "hidden" }, "claim", "Pan"),
      giftRegistryWriteMessage({ kind: "signed-out" }, "claim", "Pan"),
      giftRegistryWriteMessage({ kind: "invalid" }, "claim", "Pan"),
      giftRegistryWriteMessage({ kind: "error" }, "claim", "Pan"),
    ];
    expect(new Set(messages).size).toBe(messages.length);
    // None of them names another household.
    for (const message of messages) expect(message).not.toMatch(/by [A-Z]/);
  });
});
