// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GiftRegistry, GiftRegistryItem } from "../../lib/gift-registry";
import { noteClaimed, signOut } from "../claim-session";
import {
  giftRegistryWriteMessage,
  GiftRegistryPage,
  type GiftRegistryPageProps,
} from "./GiftRegistryPage";

/**
 * The gift list's own page.
 *
 * What is asserted here is what the spec calls load-bearing:
 *   - the list is for the couple's GUESTS: a 401 is a way in, not an error, and
 *     nothing of the list is on the page beside it;
 *   - counts reach the DOM, claimant identities never do;
 *   - the 409 race refetches and TELLS the guest, and is never painted as a
 *     success that did not happen;
 *   - a failed re-read leaves what is on screen — on a page of its own,
 *     blanking on a blip blanks everything;
 *   - a shipping address renders only when the API actually sent one;
 *   - the couple's own shelves survive a refetch with the forms open under them.
 */

const API = "https://api.test";
const SLUG = "anita-and-ben";
const INVITE_HREF = `/${SLUG}`;

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
 *
 * Both reads default to what a claimed household of this wedding gets, because
 * that is the state most of these tests are about; the gate has its own block.
 */
function routedFetch(routes: {
  list?: Response[];
  mine?: Response[];
  claim?: Response[];
  release?: Response[];
}) {
  const queues = {
    list: [...(routes.list ?? [json(registry())])],
    mine: [...(routes.mine ?? [json({ claims: [] })])],
    claim: [...(routes.claim ?? [json({ ok: true })])],
    release: [...(routes.release ?? [json({ ok: true })])],
  };
  const calls: { url: string; method: string; credentials?: RequestCredentials }[] = [];

  const take = (key: keyof typeof queues) => {
    const queue = queues[key];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return (next as Response).clone();
  };

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, credentials: init?.credentials });
    if (url.endsWith("/claim")) return take(method === "DELETE" ? "release" : "claim");
    if (url.endsWith("/registry/mine")) return take("mine");
    return take("list");
  });

  globalThis.fetch = mock as unknown as typeof fetch;
  return { mock, calls };
}

function renderPage(props: Partial<GiftRegistryPageProps> = {}) {
  return render(() => (
    <GiftRegistryPage apiUrl={API} slug={SLUG} inviteHref={INVITE_HREF} {...props} />
  ));
}

/** Resolves once the list has landed and its first card is on the page. */
function whenListed() {
  return screen.findByText("Copper pan");
}

/** Pretend this browser has claimed before, which is what gates the /mine read. */
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

describe("the gate", () => {
  it("sends a visitor with no claim to the invitation, and shows them no list", async () => {
    document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    routedFetch({
      list: [json({ error: "Unauthorized" }, 401)],
      mine: [json({ error: "Unauthorized" }, 401)],
    });
    const { container } = renderPage();

    await waitFor(() => expect(container.querySelector("[data-gift-locked]")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Open the invitation" }).getAttribute("href")).toBe(
      INVITE_HREF,
    );
    // Not one word of the couple's list is on the page beside the way in.
    expect(container.querySelector("[data-gift-item]")).toBeNull();
    expect(container.querySelector("[data-gift-availability]")).toBeNull();
    expect(container.textContent).not.toContain("Copper pan");
    // And it is not dressed as a failure — nothing has gone wrong.
    expect(container.querySelector("[data-gift-unreachable]")).toBeNull();
  });

  it("reads the list with credentials, or the cookie never leaves the browser", async () => {
    const { calls } = routedFetch({});
    renderPage();
    await whenListed();
    // `cire_session` is host-scoped to the API origin, which is a different
    // origin from the guest site: on the default `same-origin` mode the cookie
    // is dropped silently and every read is a 401 forever.
    const list = calls.find((c) => c.url.endsWith("/registry"));
    expect(list?.credentials).toBe("include");
  });

  it("opens without a reload when the session arrives in this tab", async () => {
    document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    routedFetch({
      list: [json({ error: "Unauthorized" }, 401), json(registry())],
      mine: [json({ error: "Unauthorized" }, 401), json({ claims: [] })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector("[data-gift-locked]")).toBeTruthy());

    // Exactly what the invitation does the moment a claim lands.
    setClaimedHint();
    noteClaimed();

    await whenListed();
    expect(container.querySelector("[data-gift-locked]")).toBeNull();
  });
});

describe("what the page paints", () => {
  it("names the wait rather than showing an empty frame", () => {
    routedFetch({});
    const { container } = renderPage();
    // The read is credentialed, so it cannot start until this island hydrates.
    const waiting = container.querySelector("[data-gift-waiting]");
    expect(waiting).toBeTruthy();
    expect(waiting?.getAttribute("aria-live")).toBe("polite");
  });

  /**
   * A failed re-read is NOT an answer. As a band at the foot of the invite,
   * dropping to nothing cost a section nobody had scrolled to; here it would
   * blank the page under someone reading it.
   */
  it("keeps the list on screen when a later read fails outright", async () => {
    const { calls } = routedFetch({ list: [json(registry()), json({}, 500)] });
    const { container } = renderPage();
    await whenListed();

    noteClaimed(); // any session change re-reads both routes
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/registry")).length).toBeGreaterThan(1),
    );
    expect(container.querySelector("[data-gift-item]")).toBeTruthy();
    expect(container.querySelector("[data-gift-unreachable]")).toBeNull();
  });

  it("says the list could not be reached when that is the FIRST answer", async () => {
    routedFetch({ list: [json({}, 500)] });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector("[data-gift-unreachable]")).toBeTruthy());
    expect(container.querySelector("[data-gift-locked]")).toBeNull();
  });

  it("says so, with a way back, when the couple close the list", async () => {
    routedFetch({ list: [json({ error: "registry_not_found" }, 404)] });
    const { container } = renderPage();

    await screen.findByText("The couple have closed their gift list.");
    expect(container.querySelector("[data-gift-item]")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the invitation" }).getAttribute("href")).toBe(
      INVITE_HREF,
    );
  });

  it("has its own note for a PUBLISHED list with nothing on it yet", async () => {
    routedFetch({ list: [json(registry({ items: [] }))] });
    const { container } = renderPage();
    await screen.findByText("The couple haven’t added any gifts yet.");
    // Not the closed state, and no ledger line summarising nothing as "0 of 0".
    expect(container.querySelector("[data-gift-closed]")).toBeNull();
    expect(container.querySelector("[data-gift-availability]")).toBeNull();
  });

  it("carries the couple's intro, the invite's copy first and the module's second", async () => {
    routedFetch({ list: [json(registry({ message: "No boxed gifts, please." }))] });
    const first = renderPage();
    await screen.findByText("No boxed gifts, please.");
    first.unmount();
    cleanup();

    routedFetch({ list: [json(registry({ message: "No boxed gifts, please." }))] });
    renderPage({ inviteBody: "Your presence is the present." });
    await screen.findByText("Your presence is the present.");
    expect(screen.queryByText("No boxed gifts, please.")).toBeNull();
  });
});

describe("the ledger line", () => {
  it("counts what is free out of what the couple asked for, and nothing else", async () => {
    routedFetch({
      list: [json(registry({ items: [item({ quantityWanted: 4, quantityClaimed: 1 })] }))],
    });
    const { container } = renderPage();
    await whenListed();

    expect(container.querySelector("[data-gift-availability]")?.textContent).toBe(
      "3 of 4 still available",
    );
    // Nothing of this household's is claimed, so that half is simply absent.
    expect(container.querySelector("[data-gift-claimed-count]")).toBeNull();
  });

  it("tells a household what it has reserved, in quantities and never in names", async () => {
    routedFetch({
      list: [json(registry({ items: [item({ quantityWanted: 4, quantityClaimed: 2 })] }))],
      mine: [
        json({
          claims: [
            {
              itemId: "gi-1",
              quantity: 2,
              status: "reserved",
              note: null,
              displayName: "The Ashworths",
            },
          ],
        }),
      ],
    });
    const { container } = renderPage();

    await waitFor(() =>
      expect(container.querySelector("[data-gift-claimed-count]")?.textContent).toBe(
        "You reserved 2 gifts",
      ),
    );
    expect(container.querySelector("[data-gift-availability]")?.textContent).toBe(
      "2 of 4 still available",
    );
  });
});

describe("the couple's shelves", () => {
  it("keeps their own categories, in their own order, with the unlabelled tail last", async () => {
    const items = [
      item({ id: "a", title: "Copper pan", category: "Kitchen", sortOrder: 0 }),
      item({ id: "b", title: "Picnic rug", category: null, sortOrder: 1 }),
      item({ id: "c", title: "Wine glasses", category: "Kitchen", sortOrder: 2 }),
      item({ id: "d", title: "Linen sheets", category: "Bedroom", sortOrder: 3 }),
    ];
    routedFetch({ list: [json(registry({ items }))] });
    const { container } = renderPage();
    await whenListed();

    const shelves = [...container.querySelectorAll("[data-gift-shelf]")];
    expect(shelves.map((shelf) => shelf.getAttribute("data-gift-shelf"))).toEqual([
      "Kitchen",
      "Bedroom",
      "",
    ]);
    expect(shelves[0]?.querySelectorAll("[data-gift-item]")).toHaveLength(2);
    expect(container.textContent).toContain("More gifts");
  });

  it("labels nothing when the couple grouped nothing", async () => {
    routedFetch({});
    const { container } = renderPage();
    await whenListed();
    expect(container.querySelectorAll("[data-gift-shelf]")).toHaveLength(1);
    expect(container.querySelector("h2")).toBeNull();
    expect(container.textContent).not.toContain("More gifts");
  });
});

describe("the privacy property", () => {
  it("puts counts in the DOM and no claimant identity anywhere", async () => {
    routedFetch({
      list: [json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 1 })] }))],
    });
    const { container } = renderPage();

    await screen.findByText("1 of 2 left");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/reserved by|claimed by|Ashworth/i);
    expect(container.querySelector("[data-gift-mine]")).toBeNull();
  });

  it("skips the household read entirely without the claim hint", async () => {
    document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    const { calls } = routedFetch({});
    renderPage();
    await whenListed();
    // A browser that never claimed here can only get a 401 from `…/mine`, and
    // this page is a shareable link: the wasted call would scale with page
    // views rather than with guests.
    expect(calls.some((c) => c.url.endsWith("/registry/mine"))).toBe(false);
  });
});

describe("a session that ends mid-visit", () => {
  it("explains the missing controls when only the household read lost the session", async () => {
    routedFetch({ mine: [json({ error: "Unauthorized" }, 401)] });
    const { container } = renderPage();

    await whenListed();
    // The list read had a session, so the page is not the locked one; the
    // controls are gone, and the reason is on the page instead.
    expect(container.querySelector("[data-gift-locked]")).toBeNull();
    expect(container.querySelector("[data-gift-signed-out]")?.textContent).toContain(
      "Your invite session has ended",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("drops back to the gate when the guest signs out in this tab", async () => {
    routedFetch({
      list: [json(registry()), json({ error: "Unauthorized" }, 401)],
      mine: [json({ claims: [] }), json({ error: "Unauthorized" }, 401)],
    });
    const { container } = renderPage();
    await screen.findByRole("button", { name: "Reserve" });

    await signOut(API);

    await waitFor(() => expect(container.querySelector("[data-gift-locked]")).toBeTruthy());
    expect(container.querySelector("[data-gift-item]")).toBeNull();
  });
});

describe("this household's own claims", () => {
  it("merges its own claim into the list", async () => {
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
    const { container } = renderPage();

    await waitFor(() => expect(container.querySelector("[data-gift-mine]")).toBeTruthy());
    expect(container.querySelector("[data-gift-mine]")?.textContent).toContain("The Ashworths");
  });

  it("renders the shipping address only when the API actually sent one", async () => {
    routedFetch({ mine: [json({ claims: [], shippingAddress: "12 Rose Lane\nSydney" })] });
    const first = renderPage();
    await waitFor(() => expect(first.container.querySelector("[data-gift-shipping]")).toBeTruthy());
    expect(first.container.querySelector("[data-gift-shipping]")?.textContent).toContain(
      "12 Rose Lane",
    );
    first.unmount();
    cleanup();

    routedFetch({});
    const second = renderPage();
    await screen.findByRole("button", { name: "Reserve" });
    // Absent means "you may not see it" and "there isn't one" at once, so the
    // page says nothing at all rather than inventing a reason.
    expect(second.container.querySelector("[data-gift-shipping]")).toBeNull();
    expect(second.container.textContent).not.toContain("Send gifts to");
  });
});

describe("claiming", () => {
  it("re-reads both routes after a successful claim rather than guessing", async () => {
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
    const { container } = renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText("Reserved. “Copper pan” is marked as yours.");
    // The counts come from the re-read, which lands after the message.
    await waitFor(() =>
      expect(container.querySelector("[data-gift-remaining]")?.textContent).toBe("1 of 2 left"),
    );
    expect(container.querySelector("[data-gift-mine]")).toBeTruthy();
    // The ledger moves with the list, off the same re-read.
    expect(container.querySelector("[data-gift-availability]")?.textContent).toBe(
      "1 of 2 still available",
    );
    // Two list reads: the one on mount, and the one after the write.
    expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith("/registry/mine"))).toHaveLength(2);
  });

  it("handles the 409 race honestly: refetched counts, a plain message, no fake success", async () => {
    const { calls } = routedFetch({
      list: [
        // What this guest was looking at: the last one is free.
        json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 1 })] })),
        // What is true by the time they press: another household took it.
        json(registry({ items: [item({ quantityWanted: 2, quantityClaimed: 2 })] })),
      ],
      claim: [json({ error: "item_fully_claimed" }, 409)],
    });
    const { container } = renderPage();

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

  /**
   * The same test also guards the SHELVES. The groups are rebuilt on every
   * re-read, so keying the shelf list on the group objects would dispose this
   * shelf and take the open form — and the words typed into it — down with it.
   */
  it("keeps the form open, on its own shelf, after a 409 that still leaves something", async () => {
    const shelved = (claimed: number) =>
      registry({
        items: [item({ category: "Kitchen", quantityWanted: 3, quantityClaimed: claimed })],
      });
    routedFetch({
      list: [
        json(shelved(0)),
        // The API also answers 409 when OTHER households' live claims exceed
        // what is left for the number asked — here two of three are taken and
        // one is still free, so the form is still worth having. This is why the
        // close must key on the CEILING and never on the 409 itself.
        json(shelved(2)),
      ],
      claim: [json({ error: "item_fully_claimed" }, 409)],
    });
    const { container } = renderPage();

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
    expect(container.querySelector('[data-gift-shelf="Kitchen"]')).toBeTruthy();
  });

  it("settles on the closed state when the couple unpublish mid-write", async () => {
    // `applyOutcome`'s `hidden` branch re-reads the LIST only, and the point of
    // that re-read is the end state: a 404 that turns the page into "the couple
    // have closed their gift list" rather than a stale list sitting under a
    // message that contradicts it.
    routedFetch({
      list: [json(registry()), json({ error: "registry_not_found" }, 404)],
      claim: [json({ error: "registry_not_found" }, 404)],
    });
    const { container } = renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    // Waiting on the PANEL, not the words: `giftRegistryWriteMessage` puts the
    // same sentence in the status line the moment the write answers, which is
    // before the re-read that actually closes the page.
    await waitFor(() => expect(container.querySelector("[data-gift-closed]")).toBeTruthy());
    expect(container.querySelector("[data-gift-item]")).toBeNull();
  });

  it("re-reads both routes when the couple removed the gift under us", async () => {
    // `item-gone` is the 404 for the ITEM, not the list: the list is still
    // there, so both reads run and the page keeps rendering it.
    const { calls } = routedFetch({
      claim: [json({ error: "registry_item_not_found" }, 404)],
    });
    const { container } = renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(/is no longer on the couple’s list/);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith("/registry/mine"))).toHaveLength(2);
    expect(container.querySelector("[data-gift-item]")).toBeTruthy();
  });

  it("says the session lapsed when the write is the thing that finds out", async () => {
    routedFetch({ claim: [json({ error: "unauthorised" }, 401)] });
    const { container } = renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText(
      "Your invite session has ended. Enter your invite code again to reserve a gift.",
    );
    await waitFor(() => expect(container.querySelectorAll("button")).toHaveLength(0));
    // The list they were reading is still there — only the controls are gone.
    expect(container.querySelector("[data-gift-item]")).toBeTruthy();
  });

  it("does not re-read anything when the write never reached the server", async () => {
    const { calls } = routedFetch({ claim: [json({ error: "rate_limited" }, 429)] });
    const { container } = renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText("That was a lot of changes at once. Try again in a moment.");
    expect(calls.filter((c) => c.url.endsWith("/registry"))).toHaveLength(1);
  });

  it("releases a claim and re-reads", async () => {
    const { calls } = routedFetch({
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
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Release" }));

    await screen.findByText("Released. “Copper pan” is free for another guest again.");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("the status line", () => {
  it("is a polite live region at the page root, not an overlay", async () => {
    routedFetch({});
    const { container } = renderPage();
    await whenListed();

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
