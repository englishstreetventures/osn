import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmailLinkClient, emailLinkPurpose } from "../src/email-link";

/**
 * The confirm page's calls. What each answer maps to is the page's contract:
 * every refusal reads as `expired`, which ends the page, and only a rate limit,
 * a server error or no answer throws, which offers Try again. A refusal read
 * as an error would invite presses that spend the request; a transient read as
 * a refusal would show a dead link over a live one.
 */

const client = createEmailLinkClient({ issuerUrl: "https://osn.example.com/" });
const requestId = "signup_0123456789ab";
const linkSecret = "a".repeat(64);

function stub(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirm", () => {
  it("posts the secret and the pick, and answers confirmed", async () => {
    const calls = stub(() => json({ status: "confirmed" }));
    expect(await client.confirm(requestId, { linkSecret, pick: "47" })).toBe("confirmed");
    expect(calls[0]!.url).toBe("https://osn.example.com/email-link/signup_0123456789ab/confirm");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      linkSecret,
      pairingPick: "47",
    });
  });

  it("sends a decline as the pick `none`, and answers declined", async () => {
    const calls = stub(() => json({ status: "declined" }));
    expect(await client.confirm(requestId, { linkSecret, pick: null })).toBe("declined");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      linkSecret,
      pairingPick: "none",
    });
  });

  it("answers only what was sent can earn: a number is never declined, a decline never confirmed", async () => {
    stub(() => json({ status: "declined" }));
    expect(await client.confirm(requestId, { linkSecret, pick: "47" })).toBe("expired");
    stub(() => json({ status: "confirmed" }));
    expect(await client.confirm(requestId, { linkSecret, pick: null })).toBe("expired");
  });

  it("reads every refusal as expired", async () => {
    for (const [body, status] of [
      [{ status: "expired" }, 200],
      [{ error: "invalid_request" }, 400],
      [{}, 404],
      [{ error: "invalid_request" }, 422],
    ] as const) {
      stub(() => json(body, status));
      // oxlint-disable-next-line no-await-in-loop -- one stub at a time
      expect(await client.confirm(requestId, { linkSecret, pick: "47" })).toBe("expired");
    }
  });

  it("throws on a rate limit, a server error or no answer", async () => {
    for (const status of [429, 500, 503]) {
      stub(() => json({ error: "x" }, status));
      // oxlint-disable-next-line no-await-in-loop -- one stub at a time
      await expect(client.confirm(requestId, { linkSecret, pick: "47" })).rejects.toThrow(
        `Request failed: ${status}`,
      );
    }
    stub(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(client.confirm(requestId, { linkSecret, pick: "47" })).rejects.toThrow(
      "Failed to fetch",
    );
  });
});

describe("candidates", () => {
  it("posts the secret and answers the list", async () => {
    const calls = stub(() => json({ status: "ready", pairingCandidates: ["12", "47"] }));
    expect(await client.candidates(requestId, linkSecret)).toEqual({
      status: "ready",
      candidates: ["12", "47"],
    });
    expect(calls[0]!.url).toBe("https://osn.example.com/email-link/signup_0123456789ab/candidates");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ linkSecret });
  });

  it("answers confirmed, and reads every refusal as expired", async () => {
    stub(() => json({ status: "confirmed" }));
    expect(await client.candidates(requestId, linkSecret)).toEqual({ status: "confirmed" });
    for (const status of [400, 404, 422]) {
      stub(() => json({ error: "invalid_request" }, status));
      // oxlint-disable-next-line no-await-in-loop -- one stub at a time
      expect(await client.candidates(requestId, linkSecret)).toEqual({ status: "expired" });
    }
  });

  it("throws on a rate limit, a server error or no answer", async () => {
    for (const status of [429, 500]) {
      stub(() => json({ error: "x" }, status));
      // oxlint-disable-next-line no-await-in-loop -- one stub at a time
      await expect(client.candidates(requestId, linkSecret)).rejects.toThrow(
        `Request failed: ${status}`,
      );
    }
    stub(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(client.candidates(requestId, linkSecret)).rejects.toThrow("Failed to fetch");
  });
});

describe("emailLinkPurpose", () => {
  it("reads the flow off the request id's prefix, and nothing else", () => {
    expect(emailLinkPurpose("signup_0123456789ab")).toBe("sign-up");
    expect(emailLinkPurpose("signup_")).toBeNull();
    expect(emailLinkPurpose("cdl_0123456789ab")).toBeNull();
    expect(emailLinkPurpose("signup_0123456789ab/extra")).toBeNull();
  });
});
