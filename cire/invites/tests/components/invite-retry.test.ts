import { createEffect, createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInviteRetry,
  type InviteCustomisationResponse,
} from "../../src/components/invite-retry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What a call site keeps painted until a retry lands. */
interface Painted {
  theme: string | null;
}

// ONE object identity, shared by every test. The value starts AT `fallback()`,
// so a result that merely *looks* like the fallback proves nothing — `toBe`
// against this sentinel is what tells "left alone" from "rebuilt".
const FALLBACK: Painted = { theme: "painted" };

/**
 * Mount the primitive inside a root and hand back the value and the root's
 * dispose. `onMount` runs as the root settles, so the fetch starts here.
 */
function mount(options: {
  slug?: () => string | undefined;
  fallback?: () => Painted;
  select?: (body: InviteCustomisationResponse) => Painted;
}) {
  let data!: Accessor<Painted>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    data = createInviteRetry<InviteCustomisationResponse, Painted>({
      apiUrl: () => "https://api.test",
      slug: options.slug ?? (() => "my-slug"),
      fallback: options.fallback ?? (() => FALLBACK),
      select: options.select ?? ((body) => ({ theme: body.theme?.headingFont ?? null })),
    });
  });
  return { data, dispose };
}

// Responses whose bodies settle in microtasks only, so one macrotask after the
// fetch resolves has drained the primitive's whole handler — the success test
// below is the twin that proves `settle` waits long enough to see a write.
const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;
const statusResponse = (status: number, json = vi.fn(() => Promise.resolve({}))) =>
  ({ ok: false, status, json }) as unknown as Response;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createInviteRetry", () => {
  it("fetches the invite endpoint once, no-store and credentialed", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({})));
    vi.stubGlobal("fetch", fetchMock);

    const { dispose } = mount({});
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Credentialed so it shares the connection the credentialed preconnect
    // warmed; an anonymous request would open a second one.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/invite/my-slug",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    );
    dispose();
  });

  it("encodes the slug into a single path segment", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({})));
    vi.stubGlobal("fetch", fetchMock);

    const { dispose } = mount({ slug: () => "a b/../c?x" });
    await settle();

    // The slug comes off the request path, so an unencoded one could move the
    // request to a different path or query on the API origin.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/invite/a%20b%2F..%2Fc%3Fx",
      expect.objectContaining({ cache: "no-store" }),
    );
    dispose();
  });

  it("replaces the fallback with the response, mapped through `select`", async () => {
    const body: InviteCustomisationResponse = {
      theme: { headingFont: "Lato", bodyFont: null, palette: null, tones: null },
      details: { eyebrow: "Join us", heading: null },
      welcome: { message: "Hello" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(body))),
    );
    const select = vi.fn((b: InviteCustomisationResponse) => ({
      theme: b.welcome?.message ?? null,
    }));

    const { data, dispose } = mount({ select });
    await settle();

    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0]).toEqual(body);
    expect(data()).toEqual({ theme: "Hello" });
    dispose();
  });

  it("leaves the painted value alone on a non-OK response, without reading or mapping it", async () => {
    const json = vi.fn(() => Promise.resolve({ theme: null }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(statusResponse(500, json))),
    );
    const select = vi.fn(() => ({ theme: "live" }));

    const { data, dispose } = mount({ select });
    await settle();

    // `toBe`, not `toEqual`: the fallback object itself. And `select` untouched
    // is what separates this branch from an OK response whose mapping happened
    // to return the same value.
    expect(data()).toBe(FALLBACK);
    expect(json).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    dispose();
  });

  it("leaves the painted value alone when the fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const select = vi.fn(() => ({ theme: "live" }));

    const { data, dispose } = mount({ select });
    await settle();

    expect(data()).toBe(FALLBACK);
    expect(select).not.toHaveBeenCalled();
    dispose();
  });

  it("leaves the painted value alone when an OK response has an unparseable body", async () => {
    // A 200 carrying HTML — an edge interstitial, a misrouted request — must
    // land on the same path as a thrown fetch, not reach the render as an error.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected token <")),
        } as unknown as Response),
      ),
    );
    const select = vi.fn(() => ({ theme: "live" }));

    const { data, dispose } = mount({ select });
    await settle();

    expect(data()).toBe(FALLBACK);
    expect(select).not.toHaveBeenCalled();
    dispose();
  });

  it("keeps the value's identity through a failed retry, so nothing downstream re-runs", async () => {
    // Call sites build their fallback fresh on every call (a page maps three
    // props into one object). A failure path that wrote `fallback()` again
    // would hand every consumer a new object for the same data — re-running the
    // root palette write and every memo keyed on it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(statusResponse(503))),
    );
    const seen: Painted[] = [];
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      const data = createInviteRetry<InviteCustomisationResponse, Painted>({
        apiUrl: () => "https://api.test",
        slug: () => "my-slug",
        fallback: () => ({ theme: "painted" }),
        select: () => ({ theme: "live" }),
      });
      createEffect(() => seen.push(data()));
    });
    await settle();

    expect(seen).toHaveLength(1);
    dispose();
  });

  it("follows the fallback's inputs until a response lands", async () => {
    // Island props are a store Astro reconciles, so the painted value must stay
    // a live read of them rather than a copy taken at mount.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(statusResponse(500))),
    );
    const [theme, setTheme] = createSignal<string | null>("before");
    const { data, dispose } = mount({ fallback: () => ({ theme: theme() }) });
    await settle();

    expect(data()).toEqual({ theme: "before" });
    setTheme("after");
    expect(data()).toEqual({ theme: "after" });
    dispose();
  });

  it("never fetches when there is no slug", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({})));
    vi.stubGlobal("fetch", fetchMock);

    const { data, dispose } = mount({ slug: () => undefined });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(data()).toBe(FALLBACK);
    dispose();
  });

  it("aborts the request when the island is disposed", () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );

    const { dispose } = mount({});
    expect(signal?.aborted).toBe(false);
    dispose();
    expect(signal?.aborted).toBe(true);
  });
});
