import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchInviteForTrace } from "../../src/lib/invite";

afterEach(() => vi.unstubAllGlobals());

describe("fetchInviteForTrace", () => {
  it("keeps the slug out of the traced outbound URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ inviteTraceEligible: true, designId: "classic" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchInviteForTrace("couple-name");
    expect(result.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/invite\/resolve$/);
    expect(url).not.toContain("couple-name");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ slug: "couple-name" }));
  });

  it("does not render weddings without the tracing flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ inviteTraceEligible: false })),
    );
    expect(await fetchInviteForTrace("existing-wedding")).toEqual({ kind: "not-found" });
  });
});
