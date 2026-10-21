import { describe, expect, it } from "bun:test";

import { localClientAddress } from "../../src/lib/local-client-address";

// The local server's stand-in for the edge's `cf-connecting-ip`, which every
// per-address rate limiter keys on. A caller must not choose its own key,
// except where the E2E stack asks for it.
describe("localClientAddress", () => {
  it("gives the socket peer when the request carries no address", () => {
    const headers = localClientAddress(new Headers(), "10.0.0.7", false);
    expect(headers.get("cf-connecting-ip")).toBe("10.0.0.7");
  });

  it("replaces an address the request sent, so no caller picks its own limiter key", () => {
    const sent = new Headers({ "cf-connecting-ip": "192.0.2.10" });
    expect(localClientAddress(sent, "10.0.0.7", false).get("cf-connecting-ip")).toBe("10.0.0.7");
  });

  it("keeps a sent address only when told to, and still fills a missing one", () => {
    const sent = new Headers({ "cf-connecting-ip": "192.0.2.10" });
    expect(localClientAddress(sent, "10.0.0.7", true).get("cf-connecting-ip")).toBe("192.0.2.10");
    expect(localClientAddress(new Headers(), "10.0.0.7", true).get("cf-connecting-ip")).toBe(
      "10.0.0.7",
    );
  });
});
