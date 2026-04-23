import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createStepUpClient, StepUpError } from "../src/step-up";

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
  const client = createStepUpClient({ issuerUrl: "https://osn.example.com" });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("passkeyBegin", () => {
    it("POSTs /step-up/passkey/begin with Bearer auth and returns the challenge options", async () => {
      fetchMock.mockResolvedValue(okResponse({ options: { challenge: "abc" } }));
      const result = await client.passkeyBegin({ accessToken: "acc_tok" });
      expect(result).toEqual({ options: { challenge: "abc" } });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://osn.example.com/step-up/passkey/begin");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer acc_tok");
    });
  });

  describe("passkeyComplete", () => {
    it("returns the parsed step-up token envelope", async () => {
      fetchMock.mockResolvedValue(okResponse({ step_up_token: "eyJabc", expires_in: 300 }));
      const result = await client.passkeyComplete({
        accessToken: "acc_tok",
        assertion: { id: "x" },
      });
      expect(result).toEqual({ token: "eyJabc", expiresIn: 300 });
    });
  });

  describe("otpBegin", () => {
    it("returns { sent: true }", async () => {
      fetchMock.mockResolvedValue(okResponse({ sent: true }));
      const result = await client.otpBegin({ accessToken: "acc_tok" });
      expect(result.sent).toBe(true);
    });
  });

  describe("otpComplete", () => {
    it("parses step_up_token + expires_in", async () => {
      fetchMock.mockResolvedValue(okResponse({ step_up_token: "eyJotp", expires_in: 300 }));
      const result = await client.otpComplete({ accessToken: "acc_tok", code: "123456" });
      expect(result).toEqual({ token: "eyJotp", expiresIn: 300 });
    });

    it("throws a StepUpError when the server returns non-2xx", async () => {
      fetchMock.mockResolvedValue(errResponse({ error: "invalid_code" }));
      await expect(client.otpComplete({ accessToken: "acc_tok", code: "000000" })).rejects.toThrow(
        StepUpError,
      );
    });
  });
});
