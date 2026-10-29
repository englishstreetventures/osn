// Where scripts/guest-route-parity-reference.js sends each call the Worker
// makes, one test per way it can go wrong (NEW-FEAT.md PF18, PF19, PF32).
// Logic only, under Bun: which origin goes where and which headers are added.
// What depends on the runtime — Miniflare's own Request class, Node's fetch
// and a streamed body — runs for real in guest-route-parity-wrangler.e2e.ts.

import { describe, expect, test } from "bun:test";

import {
  makeForward,
  RELAY_TOKEN_HEADER,
  WORKER_UA_HEADER,
} from "../guest-route-parity-reference.js";

const API = "https://api.cire.example.test";
const RELAY_PORT = 43_210;

interface Sent {
  readonly url: string;
  readonly init: RequestInit & { readonly duplex?: string };
}

function forwarder(): {
  readonly sent: Sent[];
  readonly forward: (request: Request) => Promise<Response>;
} {
  const sent: Sent[] = [];
  const forward = makeForward({
    apiOrigin: API,
    relayPort: RELAY_PORT,
    token: "run-token",
    fetchImpl: (url, init) => {
      sent.push({ url, init });
      return Promise.resolve(new Response("ok"));
    },
  });
  return { sent, forward };
}

const headersOf = (one: Sent | undefined): [string, string][] => [
  ...new Headers(one?.init.headers).entries(),
];

describe("the reference's outbound calls", () => {
  test("PF18: a call to any other origin goes out with the Worker's own headers untouched, never to the relay", async () => {
    const { sent, forward } = forwarder();
    await forward(
      new Request("https://fonts.example.test/a.woff2?v=1", {
        headers: { "user-agent": "the-worker", accept: "*/*" },
      }),
    );
    expect(sent.map((one) => one.url)).toEqual(["https://fonts.example.test/a.woff2?v=1"]);
    expect(headersOf(sent[0])).toEqual([
      ["accept", "*/*"],
      ["user-agent", "the-worker"],
    ]);
    expect(sent[0]?.init.method).toBe("GET");
    expect(sent[0]?.init.redirect).toBe("manual");
    expect(sent[0]?.init.duplex).toBe("half");
  });

  test.each([
    ["http in place of https", "http://api.cire.example.test/api/invite/x"],
    ["another port", "https://api.cire.example.test:8443/api/invite/x"],
    ["a host that ends with it", "https://api.cire.example.test.evil.test/api/invite/x"],
    ["a host that starts with it", "https://xapi.cire.example.test/api/invite/x"],
    ["its host as the userinfo of another", "https://api.cire.example.test@evil.test/api/invite/x"],
    ["its origin in the path of another", "https://evil.test/https://api.cire.example.test/x"],
  ])("PF19: %s is another origin, sent as it is", async (_, url) => {
    const { sent, forward } = forwarder();
    await forward(new Request(url));
    expect(sent.map((one) => new URL(one.url).href)).toEqual([new URL(url).href]);
    expect(headersOf(sent[0]).map(([name]) => name)).not.toContain(RELAY_TOKEN_HEADER);
    expect(headersOf(sent[0]).map(([name]) => name)).not.toContain(WORKER_UA_HEADER);
  });

  test("PF32: a call to cire-api goes to the relay on loopback with its path and query, the run's token, and whether the Worker sent a user agent", async () => {
    const { sent, forward } = forwarder();
    await forward(
      new Request(`${API}/api/invite/cire-wedding?from=page&x=%2F`, {
        headers: { "user-agent": "the-worker", accept: "application/json" },
      }),
    );
    const body = JSON.stringify({ slug: "cire-wedding" });
    await forward(
      new Request(`${API}/api/invite/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(sent.map((one) => one.url)).toEqual([
      `http://127.0.0.1:${RELAY_PORT}/api/invite/cire-wedding?from=page&x=%2F`,
      `http://127.0.0.1:${RELAY_PORT}/api/invite/resolve`,
    ]);
    expect(headersOf(sent[0])).toEqual([
      ["accept", "application/json"],
      ["user-agent", "the-worker"],
      [RELAY_TOKEN_HEADER, "run-token"],
      [WORKER_UA_HEADER, "present"],
    ]);
    expect(new Headers(sent[1]?.init.headers).get(WORKER_UA_HEADER)).toBe("absent");
    expect(new Headers(sent[1]?.init.headers).get(RELAY_TOKEN_HEADER)).toBe("run-token");
    expect(sent[1]?.init.method).toBe("POST");
    expect(sent[1]?.init.duplex).toBe("half");
    expect(sent[1]?.init.redirect).toBe("manual");
    expect(await new Response(sent[1]?.init.body).text()).toBe(body);
  });
});
