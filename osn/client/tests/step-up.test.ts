import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createStepUpClient, StepUpError } from "../src/step-up";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const errResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

describe("createStepUpClient", () => {
  const client = createStepUpClient({ issuerUrl: "https://osn.example.com", authFetch });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expectAllThroughAuthFetch(authFetch, "include");
    vi.unstubAllGlobals();
  });

  describe("passkeyBegin", () => {
    it("POSTs /step-up/passkey/begin through authFetch and returns the challenge options", async () => {
      fetchMock.mockResolvedValue(okResponse({ options: { challenge: "abc" } }));
      const result = await client.passkeyBegin();
      expect(result).toEqual({ options: { challenge: "abc" } });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://osn.example.com/step-up/passkey/begin");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    });
  });

  describe("passkeyComplete", () => {
    it("returns the parsed step-up token envelope", async () => {
      fetchMock.mockResolvedValue(okResponse({ step_up_token: "eyJabc", expires_in: 300 }));
      const result = await client.passkeyComplete({
        assertion: { id: "x" },
      });
      expect(result).toEqual({ token: "eyJabc", expiresIn: 300 });
    });
  });

  describe("otpComplete", () => {
    it("parses step_up_token + expires_in", async () => {
      fetchMock.mockResolvedValue(okResponse({ step_up_token: "eyJotp", expires_in: 300 }));
      const result = await client.otpComplete({ code: "123456" });
      expect(result).toEqual({ token: "eyJotp", expiresIn: 300 });
    });

    it("throws a StepUpError when the server returns non-2xx", async () => {
      fetchMock.mockResolvedValue(errResponse({ error: "invalid_code" }));
      await expect(client.otpComplete({ code: "000000" })).rejects.toThrow(StepUpError);
    });
  });
});
