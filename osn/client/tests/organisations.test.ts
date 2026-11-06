import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrgClient, OrgClientError } from "../src/organisations";

const client = createOrgClient({ issuerUrl: "https://osn.example.com" });
const base = "https://osn.example.com/organisations";
const TOKEN = "test-token";

/** An organisation as the routes answer with it. */
const ORGANISATION = {
  handle: "acme",
  name: "Acme",
  description: null,
  avatarUrl: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOrgClient — listing & reads", () => {
  it("listMyOrgs GETs /organisations with Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ organisations: [] }) });
    await client.listMyOrgs(TOKEN);
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(base);
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("listMyOrgs serialises limit/offset query params", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ organisations: [] }) });
    await client.listMyOrgs(TOKEN, { limit: 10, offset: 5 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}?limit=10&offset=5`);
  });

  it("getOrg GETs /organisations/:handle with URL encoding", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ organisation: ORGANISATION }) });
    await client.getOrg(TOKEN, "org with space");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/org%20with%20space`);
  });

  it("listMembers GETs /organisations/:handle/members", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ members: [] }) });
    await client.listMembers(TOKEN, "acme", { limit: 5 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/acme/members?limit=5`);
  });
});

describe("createOrgClient — mutations", () => {
  it("createOrg POSTs /organisations with the payload", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true, organisation: ORGANISATION }) });
    await client.createOrg(TOKEN, { handle: "acme", name: "ACME" });
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(base);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      handle: "acme",
      name: "ACME",
    });
  });

  it("updateOrg PATCHes /organisations/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true, organisation: ORGANISATION }) });
    await client.updateOrg(TOKEN, "acme", { name: "Renamed" });
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/acme`);
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ name: "Renamed" });
  });

  it("deleteOrg DELETEs /organisations/:handle and resolves to undefined", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const result = await client.deleteOrg(TOKEN, "acme");
    expect(result).toBeUndefined();
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("deleteOrg resolves even when the success body does not parse", async () => {
    // The void delete must not read the body on the success path, so an
    // unparseable one cannot make a successful delete throw. Driven with a
    // rejecting json() to prove the success path never calls it.
    mockFetch({ ok: true, status: 204, json: () => Promise.reject(new SyntaxError("no body")) });
    await expect(client.deleteOrg(TOKEN, "acme")).resolves.toBeUndefined();
  });
});

describe("createOrgClient — member mutations", () => {
  it("addMember POSTs /organisations/:handle/members/:profileHandle with {role}", async () => {
    mockFetch({ ok: true, status: 201, json: () => Promise.resolve({ ok: true }) });
    const result = await client.addMember(TOKEN, "acme", "alice", "admin");
    expect(result).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/acme/members/alice`);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ role: "admin" });
  });

  it("removeMember DELETEs /organisations/:handle/members/:profileHandle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.removeMember(TOKEN, "acme", "alice");
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/acme/members/alice`);
    expect((call[1] as RequestInit).method).toBe("DELETE");
  });

  it("removeMember resolves even when the success body does not parse", async () => {
    mockFetch({ ok: true, status: 204, json: () => Promise.reject(new SyntaxError("no body")) });
    await expect(client.removeMember(TOKEN, "acme", "alice")).resolves.toBeUndefined();
  });

  it("updateMemberRole PATCHes /organisations/:handle/members/:profileHandle with {role}", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const result = await client.updateMemberRole(TOKEN, "acme", "alice", "member");
    expect(result).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/acme/members/alice`);
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ role: "member" });
  });
});

describe("createOrgClient — error surface", () => {
  it("throws OrgClientError carrying the status on non-2xx GET", async () => {
    mockFetch({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "Organisation not found" }),
    });
    const error = await client.getOrg(TOKEN, "acme").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgClientError);
    expect((error as OrgClientError).status).toBe(404);
  });

  it("throws OrgClientError on non-2xx DELETE (reads error body)", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Forbidden" }) });
    await expect(client.deleteOrg(TOKEN, "acme")).rejects.toBeInstanceOf(OrgClientError);
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Forbidden" }) });
    await expect(client.deleteOrg(TOKEN, "acme")).rejects.toThrow("Forbidden");
  });

  it("throws OrgClientError on non-2xx PATCH", async () => {
    // Each verb closes over the caller's own error class, so assert the class
    // per verb rather than trusting the message alone.
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Forbidden" }) });
    await expect(client.updateOrg(TOKEN, "acme", { name: "X" })).rejects.toBeInstanceOf(
      OrgClientError,
    );
  });

  it("falls back to a generic message when the server omits one", async () => {
    mockFetch({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(client.createOrg(TOKEN, { handle: "x", name: "X" })).rejects.toThrow(
      /Request failed/,
    );
  });
});

describe("createOrgClient — configuration", () => {
  it("strips a trailing slash from issuerUrl", async () => {
    const trimmed = createOrgClient({ issuerUrl: "https://osn.example.com/" });
    mockFetch({ ok: true, json: () => Promise.resolve({ organisations: [] }) });
    await trimmed.listMyOrgs(TOKEN);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(base);
  });
});
