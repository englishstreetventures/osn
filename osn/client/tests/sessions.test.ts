import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import type { AuthFetch } from "../src/runtime";
import { createSessionsClient, SessionsError } from "../src/sessions";

/** Passes straight to the stubbed global `fetch`; the runtime's own behaviour is `runtime.test.ts`'s. */
const authFetch: AuthFetch = (input, init) => fetch(input, init);

const okResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createSessionsClient", () => {
  const client = createSessionsClient({ issuerUrl: "https://osn.example.com", authFetch });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list() GETs /sessions through authFetch and returns the payload", async () => {
    const sessions = [
      {
        id: "0123456789abcdef",
        uaLabel: "Firefox on macOS",
        createdAt: 1,
        lastUsedAt: 2,
        expiresAt: 3,
        isCurrent: true,
      },
    ];
    fetchMock.mockResolvedValue(okResponse({ sessions }));
    const result = await client.list();
    expect(result.sessions).toEqual(sessions);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/sessions");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("revoke() DELETEs /sessions/:id and returns revokedSelf", async () => {
    fetchMock.mockResolvedValue(okResponse({ success: true, revokedSelf: true }));
    const result = await client.revoke({ id: "0123456789abcdef" });
    expect(result.revokedSelf).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/sessions/0123456789abcdef");
    expect(init?.method).toBe("DELETE");
  });

  it("revokeAllOther() POSTs the revoke-all-other endpoint", async () => {
    fetchMock.mockResolvedValue(okResponse({ success: true }));
    const result = await client.revokeAllOther();
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/sessions/revoke-all-other");
    expect(init?.method).toBe("POST");
  });

  it("throws SessionsError on non-2xx responses", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: "unauthorized" }, 401));
    await expect(client.list()).rejects.toThrow(SessionsError);
  });
});
