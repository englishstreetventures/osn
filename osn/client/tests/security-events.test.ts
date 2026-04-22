import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createSecurityEventsClient, SecurityEventsError } from "../src/security-events";

describe("createSecurityEventsClient", () => {
  const client = createSecurityEventsClient({ issuerUrl: "https://osn.example.com" });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("list() GETs /account/security-events with Bearer auth and returns the payload", async () => {
    const events = [
      {
        id: "sev_abcdef012345",
        kind: "recovery_code_generate" as const,
        createdAt: 10,
        uaLabel: "Firefox on macOS",
        ipHash: "deadbeef",
      },
    ];
    fetchMock.mockResolvedValue(okResponse({ events }));
    const result = await client.list({ accessToken: "acc" });
    expect(result.events).toEqual(events);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/security-events");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer acc");
    expect(init?.credentials).toBe("include");
  });

  it("list() strips a trailing slash from the issuerUrl", async () => {
    const trailing = createSecurityEventsClient({
      issuerUrl: "https://osn.example.com/",
    });
    fetchMock.mockResolvedValue(okResponse({ events: [] }));
    await trailing.list({ accessToken: "acc" });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/security-events");
  });

  it("acknowledge() POSTs /account/security-events/:id/ack with the step_up_token in the body", async () => {
    fetchMock.mockResolvedValue(okResponse({ acknowledged: true }));
    const result = await client.acknowledge({
      accessToken: "acc",
      id: "sev_abcdef012345",
      stepUpToken: "eyJ.step.up",
    });
    expect(result.acknowledged).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/security-events/sev_abcdef012345/ack");
    expect(init?.method).toBe("POST");
    // S-M1: the step-up token is passed through the body (not a header) to
    // match the shape `/recovery/generate` uses.
    expect(JSON.parse(String(init?.body))).toEqual({ step_up_token: "eyJ.step.up" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer acc");
  });

  it("acknowledge() returns acknowledged:false when the server reports a miss", async () => {
    fetchMock.mockResolvedValue(okResponse({ acknowledged: false }));
    const result = await client.acknowledge({
      accessToken: "acc",
      id: "sev_000000000000",
      stepUpToken: "eyJ.step.up",
    });
    expect(result.acknowledged).toBe(false);
  });

  it("acknowledgeAll() POSTs /account/security-events/ack-all and returns the count", async () => {
    fetchMock.mockResolvedValue(okResponse({ acknowledged: 3 }));
    const result = await client.acknowledgeAll({
      accessToken: "acc",
      stepUpToken: "eyJ.step.up",
    });
    expect(result.acknowledged).toBe(3);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/security-events/ack-all");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ step_up_token: "eyJ.step.up" });
  });

  it("acknowledgeAll() throws when the payload is missing the count", async () => {
    fetchMock.mockResolvedValue(okResponse({ acknowledged: "three" }));
    await expect(
      client.acknowledgeAll({ accessToken: "acc", stepUpToken: "eyJ.step.up" }),
    ).rejects.toThrow(SecurityEventsError);
  });

  it("acknowledgeAll() throws on non-2xx responses", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: "step_up_required" }, 403));
    await expect(
      client.acknowledgeAll({ accessToken: "acc", stepUpToken: "expired.token" }),
    ).rejects.toThrow(SecurityEventsError);
  });

  it("list() throws SecurityEventsError on non-2xx responses", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: "unauthorized" }, 401));
    await expect(client.list({ accessToken: "stale" })).rejects.toThrow(SecurityEventsError);
  });

  it("list() throws SecurityEventsError when the payload is not an events array", async () => {
    fetchMock.mockResolvedValue(okResponse({ events: "not-an-array" }));
    await expect(client.list({ accessToken: "acc" })).rejects.toThrow(SecurityEventsError);
  });

  it("acknowledge() throws SecurityEventsError on non-2xx responses", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: "rate_limited" }, 429));
    await expect(
      client.acknowledge({ accessToken: "acc", id: "sev_000000000000", stepUpToken: "t" }),
    ).rejects.toThrow(SecurityEventsError);
  });
});
