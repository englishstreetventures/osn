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

  it("changeEmailBegin POSTs the new email through authFetch", async () => {
    fetchMock.mockResolvedValue(ok({ sent: true }));
    const result = await client.changeEmailBegin({
      newEmail: "next@example.com",
    });
    expect(result.sent).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/email/begin");
    expect(JSON.parse(init!.body as string)).toEqual({ new_email: "next@example.com" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("changeEmailComplete forwards the OTP + step-up token", async () => {
    fetchMock.mockResolvedValue(ok({ email: "next@example.com" }));
    const result = await client.changeEmailComplete({
      code: "123456",
      stepUpToken: "eyJtok",
    });
    expect(result.email).toBe("next@example.com");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      code: "123456",
      step_up_token: "eyJtok",
    });
  });

  it("surfaces the server error message via AccountError", async () => {
    fetchMock.mockResolvedValue(ok({ error: "step_up_required" }, 403));
    await expect(client.changeEmailComplete({ code: "000000", stepUpToken: "x" })).rejects.toThrow(
      AccountError,
    );
  });
});
