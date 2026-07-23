import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaimCode } from "./claim-code";
import type { ClaimResult, FamilyMember } from "./types";

function member(firstName: string): FamilyMember {
  return { guestId: `g-${firstName}`, firstName, lastName: "Okafor", nickname: null, eventIds: [] };
}

function claimResult(): ClaimResult {
  return {
    publicId: "OKAFOR-LILY-AB12CD",
    familyName: "Okafor",
    members: [member("Chidi")],
    events: [],
    rsvps: [],
  };
}

function submitEvent(): Event {
  return { preventDefault: () => {} } as unknown as Event;
}

/** Runs `createClaimCode` inside a root and hands back both the primitive
 * and its `dispose` — every test calls `dispose()` once it's done asserting. */
function mount(options: Parameters<typeof createClaimCode>[0]) {
  let claim!: ReturnType<typeof createClaimCode>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    claim = createClaimCode(options);
  });
  return { claim, dispose };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("createClaimCode", () => {
  it("POSTs the trimmed + uppercased code and calls onClaimed with the parsed payload", async () => {
    const response = claimResult();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClaimed = vi.fn();

    const { claim, dispose } = mount({ apiUrl: "http://x", result: () => null, onClaimed });
    claim.setCode("  okafor-lily-ab12cd  ");
    claim.handleSubmit(submitEvent());

    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://x/api/claim",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      publicId: "OKAFOR-LILY-AB12CD",
    });
    expect(onClaimed).toHaveBeenCalledWith(response);
    dispose();
  });

  it("sets the invalid-code message on a non-ok response and leaves onClaimed uncalled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const onClaimed = vi.fn();

    const { claim, dispose } = mount({ apiUrl: "http://x", result: () => null, onClaimed });
    claim.setCode("BADCODE");
    claim.handleSubmit(submitEvent());

    await vi.waitFor(() =>
      expect(claim.error()).toBe(
        "That code doesn't look right. Check your invitation and try again.",
      ),
    );
    expect(onClaimed).not.toHaveBeenCalled();
    expect(claim.loading()).toBe(false);
    dispose();
  });

  it("sets the network-error message when the fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const onClaimed = vi.fn();

    const { claim, dispose } = mount({ apiUrl: "http://x", result: () => null, onClaimed });
    claim.setCode("SOMECODE");
    claim.handleSubmit(submitEvent());

    await vi.waitFor(() =>
      expect(claim.error()).toBe("Could not connect. Please check your connection."),
    );
    expect(onClaimed).not.toHaveBeenCalled();
    expect(claim.loading()).toBe(false);
    dispose();
  });

  it("is a no-op on an empty or whitespace-only code", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onClaimed = vi.fn();

    const { claim, dispose } = mount({ apiUrl: "http://x", result: () => null, onClaimed });
    claim.setCode("   ");
    claim.handleSubmit(submitEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onClaimed).not.toHaveBeenCalled();
    dispose();
  });

  it("auto-claims a ?code= deep-link once and strips it from the URL", async () => {
    const response = claimResult();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF01");
    const onClaimed = vi.fn();

    const { dispose } = mount({ apiUrl: "http://x", result: () => null, onClaimed });

    // The URL is stripped synchronously on mount, before the fetch settles.
    expect(window.location.search).not.toContain("code=");

    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      publicId: "HOST-ABCDEF01",
    });
    dispose();
  });

  it("does not auto-claim a ?code= deep-link when a result already exists", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF01");
    const existing = claimResult();

    const { dispose } = mount({ apiUrl: "http://x", result: () => existing, onClaimed: vi.fn() });

    expect(fetchMock).not.toHaveBeenCalled();
    dispose();
  });
});
