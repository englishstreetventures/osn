import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionRestore, noteClaimed } from "./claim-session";
import type { ClaimResult } from "./types";

function claimResult(publicId = "OKAFOR-LILY-AB12CD"): ClaimResult {
  return {
    publicId,
    familyName: "Okafor",
    members: [
      { guestId: "g-chidi", firstName: "Chidi", lastName: "Okafor", nickname: null, eventIds: [] },
    ],
    events: [],
    rsvps: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `createSessionRestore` does its work in `onMount`, so it needs a real mount —
 * `createRoot` alone would not run it. Render a component that is nothing but
 * the primitive, and hand back the `result` setter so a test can change the
 * claim state mid-flight.
 */
function mount(options?: {
  initial?: ClaimResult | null;
  slug?: string;
  onRestored?: (r: ClaimResult) => void;
}) {
  const [result, setResult] = createSignal<ClaimResult | null>(options?.initial ?? null);
  const onRestored = vi.fn((r: ClaimResult) => {
    setResult(r);
    options?.onRestored?.(r);
  });
  render(() => {
    createSessionRestore({
      apiUrl: "https://api.test",
      slug: options?.slug ?? "anita-and-ben",
      result,
      onRestored,
    });
    return null;
  });
  return { onRestored, result, setResult };
}

/** Wait for the primitive's fetch + `.json()` microtasks to settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // Every test below is a RETURNING guest unless it says otherwise: the restore
  // is gated on the non-credential `cire_claimed` hint, so without this the
  // primitive short-circuits before it ever reaches the network.
  noteClaimed();
});

afterEach(() => {
  cleanup();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("createSessionRestore", () => {
  it("restores the invite when the session resolves", async () => {
    const payload = claimResult();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));

    const { onRestored } = mount();
    await settle();

    expect(onRestored).toHaveBeenCalledOnce();
    expect(onRestored.mock.calls[0]![0].publicId).toBe("OKAFOR-LILY-AB12CD");
  });

  it("requests the restore endpoint with the household cookie, uncached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(claimResult()));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/claim/session?slug=anita-and-ben",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("does not fetch at all when the invite is already open", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(claimResult()));
    vi.stubGlobal("fetch", fetchMock);

    mount({ initial: claimResult() });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not restore over a ?code= deep-link — the explicit code wins", async () => {
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");
    const fetchMock = vi.fn().mockResolvedValue(json(claimResult()));
    vi.stubGlobal("fetch", fetchMock);

    const { onRestored } = mount();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("never clobbers a claim that landed while the restore was in flight", async () => {
    // The race the post-fetch guard exists for: a guest types their code on a
    // slow connection and their (possibly different — e.g. host-preview) claim
    // resolves first. Deleting that guard leaves every other test green.
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );

    const { onRestored, setResult } = mount();
    // The guest's own claim lands first...
    setResult(claimResult("TYPED-BY-GUEST-0001"));
    // ...and only then does the restore come back with the stale payload.
    release(json(claimResult("STALE-FROM-SESSION")));
    await settle();

    expect(onRestored).not.toHaveBeenCalled();
  });

  it("ignores a 200 whose body is not a claim payload", async () => {
    // The client half of the S-H1 trust boundary: without this a truncated or
    // error-shaped 200 is spread onto claimResult and the page renders a
    // household with no members.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ familyName: "Okafor" })));

    const { onRestored } = mount();
    await settle();

    expect(onRestored).not.toHaveBeenCalled();
  });

  it("leaves the code form standing on a 401 (no session)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Unauthorized" }, 401)));

    const { onRestored } = mount();
    await settle();

    expect(onRestored).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])(
    "degrades to the code form on a %i, not a broken page",
    async (status) => {
      // 429 matters now the route carries its own limiter: a rate-limited restore
      // must fall back to code entry rather than leaving the guest stranded.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "nope" }, status)));

      const { onRestored } = mount();
      await settle();

      expect(onRestored).not.toHaveBeenCalled();
    },
  );

  it("survives a rejected fetch (offline / DNS failure)", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const { onRestored } = mount();
    await settle();

    process.off("unhandledRejection", onUnhandled);
    expect(onRestored).not.toHaveBeenCalled();
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("never calls the API for a browser that has not claimed here", async () => {
    // The gating hint. Without it every first-time visitor — and every link
    // preview crawler — would spend an account-wide Workers invocation to be
    // told 401, on a budget shared with osn-api.
    document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    const fetchMock = vi.fn().mockResolvedValue(json(claimResult()));
    vi.stubGlobal("fetch", fetchMock);

    const { onRestored } = mount();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("does not restore without a slug — an unscoped restore has no correct answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(claimResult()));
    vi.stubGlobal("fetch", fetchMock);

    const { onRestored } = mount({ slug: "" });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("keeps the hint on a 401 — a wrong-wedding 401 must not disable a good session", async () => {
    // The 401 is deliberately ambiguous (dead session vs. right guest, wrong
    // wedding). Clearing the hint on the second case would make a guest who
    // once opened someone else's link retype their code on their own invite.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Invalid credentials" }, 401)));
    mount();
    await settle();

    expect(document.cookie).toContain("cire_claimed=");
  });
});
