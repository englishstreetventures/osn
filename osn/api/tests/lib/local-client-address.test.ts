import { describe, expect, it } from "vitest";

import { keepSentClientAddress } from "../../src/lib/local-client-address";

/**
 * The address osn-api's local Bun server reports for a request when the E2E
 * stack asks it to keep a sent one. Every per-address limiter keys on it, so
 * anything but a well-formed address falls back to the socket peer.
 */

const PEER = { address: "127.0.0.1", family: "IPv4", port: 51234 } as const;
const peer = () => PEER;
const sent = (value?: string) =>
  new Request("http://localhost:4000/profiles/list", {
    headers: value === undefined ? {} : { "cf-connecting-ip": value },
  });

describe("keepSentClientAddress", () => {
  it("keeps a sent IPv4 address", () => {
    expect(keepSentClientAddress(peer)(sent("192.0.2.11"))?.address).toBe("192.0.2.11");
  });

  it("keeps a sent IPv6 address", () => {
    expect(keepSentClientAddress(peer)(sent("2001:db8::11"))).toEqual({
      address: "2001:db8::11",
      family: "IPv6",
      port: 0,
    });
  });

  it("answers the socket peer when nothing is sent", () => {
    expect(keepSentClientAddress(peer)(sent())).toBe(PEER);
  });

  it.each(["not-an-ip", "192.0.2.11, 198.51.100.7", "", "999.0.0.1"])(
    "answers the socket peer for a sent value that is not one address: %j",
    (value) => {
      expect(keepSentClientAddress(peer)(sent(value))).toBe(PEER);
    },
  );
});
