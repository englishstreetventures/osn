import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrgClient, OrgClientError } from "../src/organisations";

const client = createOrgClient({ issuerUrl: "https://osn.example.com" });
const base = "https://osn.example.com/organisations";
const TOKEN = "test-token";

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

  it("getOrg GETs /organisations/:id with URL encoding", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ id: "org_1" }) });
    await client.getOrg(TOKEN, "org with space");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/org%20with%20space`);
  });

  it("listMembers GETs /organisations/:id/members", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ members: [] }) });
    await client.listMembers(TOKEN, "org_1", { limit: 5 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/org_1/members?limit=5`);
  });
});

describe("createOrgClient — mutations", () => {
  it("createOrg POSTs /organisations with the payload", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ id: "org_1" }) });
    await client.createOrg(TOKEN, { handle: "acme", name: "ACME" });
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(base);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      handle: "acme",
      name: "ACME",
    });
  });

  it("updateOrg PATCHes /organisations/:id", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ id: "org_1" }) });
    await client.updateOrg(TOKEN, "org_1", { name: "Renamed" });
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/org_1`);
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ name: "Renamed" });
  });

  it("deleteOrg DELETEs /organisations/:id and resolves to undefined", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const result = await client.deleteOrg(TOKEN, "org_1");
    expect(result).toBeUndefined();
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("deleteOrg resolves even when the success body does not parse", async () => {
    // The void delete must not read the body on the success path, so an
    // unparseable one cannot make a successful delete throw. Driven with a
    // rejecting json() to prove the success path never calls it.
    mockFetch({ ok: true, status: 204, json: () => Promise.reject(new SyntaxError("no body")) });
    await expect(client.deleteOrg(TOKEN, "org_1")).resolves.toBeUndefined();
  });
});

describe("createOrgClient — member mutations", () => {
  it("addMember POSTs with {profileId, role} and resolves to undefined", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const result = await client.addMember(TOKEN, "org_1", "usr_1", "admin");
    expect(result).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/org_1/members`);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      profileId: "usr_1",
      role: "admin",
    });
  });

  it("removeMember DELETEs /organisations/:id/members/:profileId", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({}) });
    await client.removeMember(TOKEN, "org_1", "usr_1");
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/org_1/members/usr_1`);
    expect((call[1] as RequestInit).method).toBe("DELETE");
  });

  it("removeMember resolves even when the success body does not parse", async () => {
    mockFetch({ ok: true, status: 204, json: () => Promise.reject(new SyntaxError("no body")) });
    await expect(client.removeMember(TOKEN, "org_1", "usr_1")).resolves.toBeUndefined();
  });

  it("updateMemberRole PATCHes with {role} and resolves to undefined", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const result = await client.updateMemberRole(TOKEN, "org_1", "usr_1", "member");
    expect(result).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/org_1/members/usr_1`);
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ role: "member" });
  });
});

describe("createOrgClient — error surface", () => {
  it("throws OrgClientError on non-2xx GET", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Not found" }) });
    await expect(client.getOrg(TOKEN, "org_1")).rejects.toBeInstanceOf(OrgClientError);
  });

  it("throws OrgClientError on non-2xx DELETE (reads error body)", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Forbidden" }) });
    await expect(client.deleteOrg(TOKEN, "org_1")).rejects.toBeInstanceOf(OrgClientError);
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Forbidden" }) });
    await expect(client.deleteOrg(TOKEN, "org_1")).rejects.toThrow("Forbidden");
  });

  it("throws OrgClientError on non-2xx PATCH", async () => {
    // Each verb closes over the caller's own error class, so assert the class
    // per verb rather than trusting the message alone.
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Forbidden" }) });
    await expect(client.updateOrg(TOKEN, "org_1", { name: "X" })).rejects.toBeInstanceOf(
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
