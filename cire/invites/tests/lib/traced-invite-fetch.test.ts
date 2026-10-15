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
  });

  it("renders an existing wedding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ designId: "classic" })),
    );
    expect(await fetchInviteForQueryRoute("existing-wedding")).toEqual({
      kind: "ok",
      invite: { designId: "classic" },
    });
  });
});
