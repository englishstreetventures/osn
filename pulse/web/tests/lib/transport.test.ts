import { describe, expect, it, vi } from "vitest";

import { serverFetch } from "../../src/lib/transport";

const API = "http://pulse-api.internal:3001";

/** A `fetch` double that records each call and answers 200. */
function recorder() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  });
  return { fetch, calls };
}

const cookieSent = (init: RequestInit | undefined): string | null =>
  new Headers(init?.headers).get("cookie");

describe("serverFetch", () => {
  it("forwards only the Pulse session cookie out of the page request's cookies", async () => {
    const { fetch, calls } = recorder();
    await serverFetch(`${API}/events/calendar`, undefined, {
      cookieHeader: "theme=dark; pulse_web_session=tok_abc-123; cire_session=other; osn_s=x",
      apiOrigin: API,
      fetch,
    });
    expect(cookieSent(calls[0]!.init)).toBe("pulse_web_session=tok_abc-123");
  });

  it("sends no Cookie header when the page request carries no session", async () => {
    const { fetch, calls } = recorder();
    await serverFetch(`${API}/api/auth/session`, undefined, {
      cookieHeader: "theme=dark; cire_session=other",
      apiOrigin: API,
      fetch,
    });
    expect(cookieSent(calls[0]!.init)).toBeNull();

    await serverFetch(`${API}/api/auth/session`, undefined, {
      cookieHeader: null,
      apiOrigin: API,
      fetch,
    });
    expect(cookieSent(calls[1]!.init)).toBeNull();
  });

  it("never sends the session cookie to any origin but pulse-api's", async () => {
    const { fetch, calls } = recorder();
    const context = { cookieHeader: "pulse_web_session=tok_abc", apiOrigin: API, fetch };
    await serverFetch("https://geocoder.example/search?q=x", undefined, context);
    await serverFetch(new URL("http://pulse-api.internal:9999/events"), undefined, context);
    await serverFetch("not a url", undefined, context);
    expect(calls.map((call) => cookieSent(call.init))).toEqual([null, null, null]);
  });

  it("drops a Cookie header the caller set, so nothing but the session reaches the API", async () => {
    const { fetch, calls } = recorder();
    await serverFetch(
      `${API}/events`,
      { headers: { cookie: "injected=1", accept: "application/json" } },
      { cookieHeader: null, apiOrigin: API, fetch },
    );
    const sent = new Headers(calls[0]!.init?.headers);
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("accept")).toBe("application/json");
  });

  it("never passes `credentials`, which workerd refuses", async () => {
    const { fetch, calls } = recorder();
    await serverFetch(
      `${API}/events`,
      { credentials: "include", method: "GET" },
      { cookieHeader: "pulse_web_session=tok_abc", apiOrigin: API, fetch },
    );
    expect(calls[0]!.init).not.toHaveProperty("credentials");
    expect(calls[0]!.init?.method).toBe("GET");
  });
});
