import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchInviteForQueryRoute } from "../../src/lib/invite";

afterEach(() => vi.unstubAllGlobals());

describe("fetchInviteForQueryRoute", () => {
  it("keeps the slug out of the outbound URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ designId: "classic" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchInviteForQueryRoute("couple-name");
    expect(result.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/invite\/resolve$/);
    expect(url).not.toContain("couple-name");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ slug: "couple-name" }));
    // Without the JSON content type the API cannot read the body, and every
    // fixed-path link would answer "not found".
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.cache).toBe("no-store");
  });

  it("returns the invite payload for an existing wedding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ designId: "classic" })),
    );
    expect(await fetchInviteForQueryRoute("existing-wedding")).toEqual({
      kind: "ok",
      invite: { designId: "classic" },
    });
  });

  it("reports an unknown wedding as not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })),
    );
    expect(await fetchInviteForQueryRoute("no-such-wedding")).toEqual({ kind: "not-found" });
  });

  it.each([500, 503, 403, 429])(
    "reports a %i from the API as an error, not a 404",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      expect(await fetchInviteForQueryRoute("a-wedding")).toEqual({ kind: "error" });
    },
  );

  it("reports an unreachable API as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await fetchInviteForQueryRoute("a-wedding")).toEqual({ kind: "error" });
  });
});
