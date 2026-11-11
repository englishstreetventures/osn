import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createAccountClient, AccountError } from "../src/account";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createAccountClient", () => {
  const client = createAccountClient({ issuerUrl: "https://osn.example.com", authFetch });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expectAllThroughAuthFetch(authFetch, "include");
    vi.unstubAllGlobals();
  });

  const REQUEST = {
    requestId: "emailchange_0123456789ab",
    claimSecret: "c".repeat(64),
    pairingCode: "42",
    expiresAt: 1_900_000_000,
  };

  it("changeEmailBegin POSTs the new email through authFetch and returns the request", async () => {
    fetchMock.mockResolvedValue(ok(REQUEST));
    const result = await client.changeEmailBegin({
      newEmail: "next@example.com",
    });
    expect(result).toEqual(REQUEST);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/email/begin");
    expect(JSON.parse(init!.body as string)).toEqual({ new_email: "next@example.com" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("changeEmailStatus reads a refusal as expired and a transient as a throw", async () => {
    const poll = () =>
      client.changeEmailStatus({
        requestId: REQUEST.requestId,
        claimSecret: REQUEST.claimSecret,
      });
    fetchMock.mockResolvedValueOnce(ok({ status: "confirmed" }));
    expect(await poll()).toEqual({ status: "confirmed" });
    fetchMock.mockResolvedValueOnce(ok({ status: "pending", pairingCode: "42" }));
    expect(await poll()).toEqual({ status: "pending", pairingCode: "42" });
    for (const status of [400, 401, 404, 422]) {
      fetchMock.mockResolvedValueOnce(ok({ error: "x" }, status));
      expect(await poll()).toEqual({ status: "expired" });
    }
    for (const status of [429, 500]) {
      fetchMock.mockResolvedValueOnce(ok({ error: "x" }, status));
      await expect(poll()).rejects.toThrow(AccountError);
    }
  });

  it("changeEmailComplete forwards the request's claim secret + step-up token", async () => {
    fetchMock.mockResolvedValue(ok({ email: "next@example.com" }));
    const result = await client.changeEmailComplete({
      requestId: REQUEST.requestId,
      claimSecret: REQUEST.claimSecret,
      stepUpToken: "eyJtok",
    });
    expect(result.email).toBe("next@example.com");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://osn.example.com/account/email/${REQUEST.requestId}/complete`);
    expect(JSON.parse(init!.body as string)).toEqual({
      claimSecret: REQUEST.claimSecret,
      step_up_token: "eyJtok",
    });
  });

  it("surfaces the server error message via AccountError", async () => {
    fetchMock.mockResolvedValue(ok({ error: "step_up_required" }, 403));
    await expect(
      client.changeEmailComplete({
        requestId: REQUEST.requestId,
        claimSecret: REQUEST.claimSecret,
        stepUpToken: "x",
      }),
    ).rejects.toThrow(AccountError);
  });
});
