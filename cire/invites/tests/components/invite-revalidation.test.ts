import { createRoot, type InitializedResource } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInviteRevalidation,
  type InviteCustomisationResponse,
} from "../../src/components/invite-revalidation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What a call site keeps painted while the revalidation is in flight. */
interface Painted {
  theme: string | null;
}

// ONE object identity, shared by every test. `fallback()` is also the resource's
// `initialValue`, so a result that merely *looks* like the fallback proves
// nothing — `toBe` against this sentinel is what tells the two apart.
const FALLBACK: Painted = { theme: "painted" };

/**
 * Mount the primitive inside a root and hand back both the resource and the
 * root's dispose. Every assertion below waits for `loading` to go false first:
 * the resource starts AT `fallback()`, so anything read before the fetcher
 * settles is green whether the failure paths exist or not.
 */
function mount(options: {
  apiUrl?: () => string;
  slug?: () => string | undefined;
  select?: (body: InviteCustomisationResponse) => Painted;
}) {
  let data!: InitializedResource<Painted>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    data = createInviteRevalidation<InviteCustomisationResponse, Painted>({
      apiUrl: options.apiUrl ?? (() => "https://api.test"),
      slug: options.slug ?? (() => "my-slug"),
      fallback: () => FALLBACK,
      select: options.select ?? ((body) => ({ theme: body.theme?.headingFont ?? null })),
    });
  });
  return { data, dispose };
}

const settled = (data: InitializedResource<Painted>) =>
  vi.waitFor(() => expect(data.loading).toBe(false));

describe("createInviteRevalidation", () => {
  it("fetches the invite endpoint once, no-store", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { data, dispose } = mount({});
    await settled(data);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/invite/my-slug",
      expect.objectContaining({ cache: "no-store" }),
    );
    dispose();
  });

  it("encodes the slug into a single path segment", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { data, dispose } = mount({ slug: () => "a b/../c?x" });
    await settled(data);

    // The slug comes off the request path, so an unencoded one could move the
    // request to a different path or query on the API origin.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/invite/a%20b%2F..%2Fc%3Fx",
      expect.objectContaining({ cache: "no-store" }),
    );
    dispose();
  });

  it("keeps the fallback when an OK response has an unparseable body", async () => {
    // `res.json()` and `select` both run after the `await`, inside the same
    // try. A 200 carrying HTML — an edge interstitial, a misrouted request —
    // must land on the same path as a thrown fetch, not settle the resource
    // errored and rethrow at the render.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("<html>oops</html>", { status: 200 }))),
    );

    const { data, dispose } = mount({});
    await settled(data);

    expect(data.error).toBeUndefined();
    expect(data()).toBe(FALLBACK);
    dispose();
  });

  it("maps an OK response through `select`", async () => {
    const body: InviteCustomisationResponse = {
      theme: { headingFont: "Lato", bodyFont: null, palette: null, tones: null },
      details: { eyebrow: "Join us", heading: null },
      welcome: { message: "Hello" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
    );
    const select = vi.fn((b: InviteCustomisationResponse) => ({
      theme: b.welcome?.message ?? null,
    }));

    const { data, dispose } = mount({ select });
    await settled(data);

    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0]).toEqual(body);
    expect(data()).toEqual({ theme: "Hello" });
    dispose();
  });

  it("keeps the fallback on a non-OK response, without mapping it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 500 }))),
    );
    const select = vi.fn(() => ({ theme: "live" }));

    const { data, dispose } = mount({ select });
    await settled(data);

    // `toBe`, not `toEqual`: the fallback object itself, not a lookalike. And
    // `select` untouched is the only thing that separates this branch from the
    // OK one, since a `select` that returned the fallback would pass the first.
    expect(data()).toBe(FALLBACK);
    expect(select).not.toHaveBeenCalled();
    dispose();
  });

  it("keeps the fallback when the fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { data, dispose } = mount({});
    await settled(data);

    // Without the catch the resource settles `errored` and reading it rethrows,
    // so both halves matter: no error recorded, and the painted value intact.
    expect(data.error).toBeUndefined();
    expect(data()).toBe(FALLBACK);
    dispose();
  });

  it("never fetches when there is no slug", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { data, dispose } = mount({ slug: () => undefined });

    // The fetcher runs synchronously at creation and calls `fetch` before its
    // first `await`, so a missing short-circuit is already visible here.
    expect(fetchMock).not.toHaveBeenCalled();
    await settled(data);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data()).toBe(FALLBACK);
    dispose();
  });
});
