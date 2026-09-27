import { describe, expect, it } from "vitest";

import { weddingTopicUrl } from "../../src/lib/realtime";

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
