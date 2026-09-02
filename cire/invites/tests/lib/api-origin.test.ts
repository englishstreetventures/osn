import { describe, expect, it } from "vitest";

import { apiPreconnectHref } from "../../src/lib/api-origin";

describe("apiPreconnectHref", () => {
  it("reduces a plain API base to its origin", () => {
    expect(apiPreconnectHref("https://api.cireweddings.com")).toBe("https://api.cireweddings.com");
  });

  it("strips any path, query and hash — preconnect takes an origin, not a URL", () => {
    expect(apiPreconnectHref("https://api.cireweddings.com/api/invite?x=1#y")).toBe(
      "https://api.cireweddings.com",
    );
  });

  it("keeps a non-default port (the local dev API is :8787)", () => {
    expect(apiPreconnectHref("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("drops the default port, matching what the browser connects to", () => {
    expect(apiPreconnectHref("https://api.cireweddings.com:443")).toBe(
      "https://api.cireweddings.com",
    );
  });

  it("returns null for a malformed base rather than throwing — a bad env var must not 500 the invite", () => {
    expect(apiPreconnectHref("not a url")).toBeNull();
    expect(apiPreconnectHref("")).toBeNull();
  });

  it("returns null for a non-http(s) scheme", () => {
    expect(apiPreconnectHref("ftp://api.cireweddings.com")).toBeNull();
    // Opaque origin — `new URL` succeeds but `origin` is the string "null".
    expect(apiPreconnectHref("data:text/plain,hi")).toBeNull();
  });
});
