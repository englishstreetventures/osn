import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createSessionsClient, SessionsError } from "../src/sessions";

const config = { issuerUrl: "https://osn.example.com" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createSessionsClient", () => {
  describe("listSessions", () => {
    it("decodes snake_case wire rows into camelCase SessionSummary", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse(200, {
          sessions: [
            {
              id: "a".repeat(64),
              created_at: 1_700_000_000,
              last_seen_at: 1_700_001_000,
              expires_at: 1_702_000_000,
              user_agent: "UnitTest/1.0",
              device_label: null,
              ip_hash_prefix: "deadbeefdead",
              created_ip_hash_prefix: null,
              is_current: true,
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const client = createSessionsClient(config);
      const { sessions } = await client.listSessions({ accessToken: "acc_123" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual({
        id: "a".repeat(64),
        createdAt: 1_700_000_000,
        lastSeenAt: 1_700_001_000,
        expiresAt: 1_702_000_000,
        userAgent: "UnitTest/1.0",
        deviceLabel: null,
        ipHashPrefix: "deadbeefdead",
        createdIpHashPrefix: null,
        isCurrent: true,
      });

      const [, init] = fetchMock.mock.calls[0]!;
      expect((init as RequestInit).credentials).toBe("include");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer acc_123");
    });

    it("throws SessionsError on non-OK response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(401, { error: "unauthorized" })),
      );
      const client = createSessionsClient(config);
      await expect(client.listSessions({ accessToken: "bad" })).rejects.toThrowError(SessionsError);
    });
  });

  describe("revokeSession", () => {
    it("sends DELETE with the session id in the path, returns wasCurrent", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse(200, { success: true, was_current: true }));
      vi.stubGlobal("fetch", fetchMock);

      const client = createSessionsClient(config);
      const result = await client.revokeSession({
        accessToken: "acc_123",
        sessionId: "b".repeat(64),
      });
      expect(result.wasCurrent).toBe(true);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://osn.example.com/sessions/${"b".repeat(64)}`);
      expect((init as RequestInit).method).toBe("DELETE");
    });

    it("throws SessionsError on 404", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(404, { error: "not_found" })));
      const client = createSessionsClient(config);
      await expect(
        client.revokeSession({ accessToken: "acc", sessionId: "c".repeat(64) }),
      ).rejects.toThrowError(SessionsError);
    });
  });

  describe("revokeOtherSessions", () => {
    it("sends POST and returns the revoked count", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { success: true, revoked: 3 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = createSessionsClient(config);
      const result = await client.revokeOtherSessions({ accessToken: "acc_123" });
      expect(result.revoked).toBe(3);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://osn.example.com/sessions/revoke-others");
      expect((init as RequestInit).method).toBe("POST");
    });

    it("strips trailing slash from issuer URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { success: true, revoked: 0 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = createSessionsClient({ issuerUrl: "https://osn.example.com/" });
      await client.revokeOtherSessions({ accessToken: "acc" });
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://osn.example.com/sessions/revoke-others");
    });
  });
});
