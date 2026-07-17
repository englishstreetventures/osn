import { describe, expect, it, vi } from "vitest";

import {
  consumeClaim,
  fetchClaimPreview,
  fetchListing,
  listMyOrgs,
  putListing,
} from "./vendor-store";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("vendor-store", () => {
  it("listMyOrgs GETs osn-api /organisations and returns the array", async () => {
    const authFetch = vi.fn().mockResolvedValue(
      jsonRes({
        organisations: [
          {
            id: "o1",
            handle: "h",
            name: "N",
            description: null,
            avatarUrl: null,
            ownerId: "p",
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
    );
    const orgs = await listMyOrgs(authFetch);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.id).toBe("o1");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/organisations");
  });

  it("fetchListing returns the listing on 200", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ listing: { id: "l1", ownerOrgId: "o1", name: "N", categories: ["venue"] } }),
      );
    const listing = await fetchListing(authFetch, "o1");
    expect(listing!.id).toBe("l1");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/vendor/orgs/o1/listing");
  });

  it("fetchListing returns null when the org has no listing (listing: null)", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ listing: null }));
    expect(await fetchListing(authFetch, "o1")).toBeNull();
  });

  it("putListing PUTs the body and returns the saved listing", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ listing: { id: "l1", name: "New", categories: ["venue", "catering"] } }),
      );
    const saved = await putListing(authFetch, "o1", {
      name: "New",
      categories: ["venue", "catering"],
    });
    expect(saved.name).toBe("New");
    const init = authFetch.mock.calls[0]![1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toMatchObject({ name: "New", categories: ["venue", "catering"] });
  });

  it("fetchClaimPreview returns the preview on 200 and null on any non-2xx", async () => {
    const g = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonRes({ listing: { directoryVendorId: "d1", name: "Preview Co" } }));
    expect(await fetchClaimPreview("tok")).toEqual({ directoryVendorId: "d1", name: "Preview Co" });
    // 404 → null (token not found / already consumed)
    g.mockResolvedValueOnce(jsonRes({ error: "claim_not_found" }, 404));
    expect(await fetchClaimPreview("tok")).toBeNull();
    // 500 → null (server error — show same generic "no longer valid" UI)
    g.mockResolvedValueOnce(jsonRes({ error: "internal_error" }, 500));
    expect(await fetchClaimPreview("tok")).toBeNull();
    // 429 → null (rate limited — same treatment)
    g.mockResolvedValueOnce(jsonRes({ error: "rate_limited" }, 429));
    expect(await fetchClaimPreview("tok")).toBeNull();
    g.mockRestore();
  });

  it("consumeClaim POSTs {orgId} to the consume route and returns the listing", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ listing: { id: "l1", ownerOrgId: "o1", name: "N", categories: [] } }),
      );
    const listing = await consumeClaim(authFetch, "tok", "o1");
    expect(listing.ownerOrgId).toBe("o1");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/vendor/claims/tok/consume");
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({ orgId: "o1" });
  });

  it("putListing throws with the server error message on non-2xx", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "not_org_member" }, 403));
    await expect(putListing(authFetch, "o1", { name: "x", categories: ["venue"] })).rejects.toThrow(
      /not_org_member/,
    );
  });
});
