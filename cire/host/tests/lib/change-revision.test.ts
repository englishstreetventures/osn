import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import { loadHeadRevision } from "../../src/lib/change-revision";
import { redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("loadHeadRevision", () => {
  afterEach(() => resetOrganiserMocks());

  it("GETs the wedding's change head and returns its revision", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ revision: "rev_1" }));
    await expect(loadHeadRevision(authFetch, "wed_a")).resolves.toBe("rev_1");
    expect(String(authFetch.mock.calls[0]![0])).toBe(
      "https://api.test/api/organiser/weddings/wed_a/changes/head",
    );
  });

  it("sends a 401 to sign-in and rejects", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "unauthorised" }, 401));
    await expect(loadHeadRevision(authFetch, "wed_a")).rejects.toThrow("unauthenticated");
    expect(redirectSpy).toHaveBeenCalled();
  });

  it("rejects on any other failure, so the editor shows a load error instead of a draft", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "read_only_role" }, 403));
    await expect(loadHeadRevision(authFetch, "wed_a")).rejects.toThrow(
      "Failed to load the change head",
    );
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  // A draft with no revision cannot be saved, so a body without one is a load
  // failure — never a revision of "undefined" posted back later.
  for (const [label, body] of [
    ["no revision", {}],
    ["an empty revision", { revision: "" }],
    ["a non-string revision", { revision: 7 }],
  ] as const) {
    it(`rejects a body with ${label}`, async () => {
      const authFetch = vi.fn().mockResolvedValue(jsonRes(body));
      await expect(loadHeadRevision(authFetch, "wed_a")).rejects.toThrow(/unavailable/);
    });
  }

  it("rejects a body that is not JSON", async () => {
    const authFetch = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(loadHeadRevision(authFetch, "wed_a")).rejects.toThrow(/unavailable/);
  });
});
