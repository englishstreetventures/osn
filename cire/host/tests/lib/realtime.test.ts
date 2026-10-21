import { afterEach, describe, expect, it, vi } from "vitest";

import { CIRE_API_URL } from "../../src/lib/osn";
import { reportRealtimeFallback, weddingTopicUrl } from "../../src/lib/realtime";

describe("weddingTopicUrl", () => {
  it("swaps https for wss on the API's origin", () => {
    expect(weddingTopicUrl("wed_a", "https://api.cireweddings.com")).toBe(
      "wss://api.cireweddings.com/realtime/cire%3Awedding%3Awed_a",
    );
  });

  it("swaps http for ws and drops a trailing slash", () => {
    expect(weddingTopicUrl("wed_a", "http://localhost:8787/")).toBe(
      "ws://localhost:8787/realtime/cire%3Awedding%3Awed_a",
    );
  });

  it("is null for an id that cannot form a topic", () => {
    expect(weddingTopicUrl("", "https://api.cireweddings.com")).toBeNull();
    expect(weddingTopicUrl("wed:a", "https://api.cireweddings.com")).toBeNull();
  });
});

describe("reportRealtimeFallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the outcome to cire-api's fallback beacon, with no credentials", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    reportRealtimeFallback("refused");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${CIRE_API_URL}/api/realtime/fallback`, {
      method: "POST",
      body: "refused",
      keepalive: true,
      credentials: "omit",
    });
  });
});
