import { describe, expect, it } from "vitest";

import { issuerPreconnect } from "../vite.config";

/**
 * T-M1 / AZ-P-I1. Every failure mode of this plugin is silent: a dropped
 * `crossorigin` opens a *second* connection instead of reusing one (the exact
 * opposite of the optimisation), and a typo'd env var emits no tag and no
 * warning. Nothing about `/authorize` looks broken in any of those cases — the
 * handshake is just paid again. So the attributes are pinned here.
 */

type Descriptor = { tag: string; attrs?: Record<string, string>; injectTo?: string };

/** Drive the plugin's two hooks directly — it is a plain factory. */
function emit(issuerUrl: string | undefined): Descriptor[] {
  const plugin = issuerPreconnect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only `env` is read
  (plugin.configResolved as any)({ env: { VITE_OSN_ISSUER_URL: issuerUrl } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no-arg call
  return (plugin.transformIndexHtml as any)() as Descriptor[];
}

describe("issuerPreconnect", () => {
  it("emits one preconnect for the issuer origin", () => {
    const tags = emit("https://id.musubi.social");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.tag).toBe("link");
    expect(tags[0]!.attrs?.rel).toBe("preconnect");
    expect(tags[0]!.attrs?.href).toBe("https://id.musubi.social");
  });

  // S-L1 / P-W2. The connection-pool key includes the credentials flag, and
  // `GET /authorize/context` is `credentials: "include"`. An anonymous
  // preconnect (`crossorigin=""`) lands in a different bucket, so the socket is
  // not reused AND an extra idle TLS connection is opened — strictly worse than
  // emitting nothing. This assertion is the only thing standing between the
  // feature and that regression.
  it("opens the connection in credentialed CORS mode", () => {
    expect(emit("https://id.musubi.social")[0]!.attrs?.crossorigin).toBe("use-credentials");
  });

  it("preconnects to the origin only, never a path", () => {
    // A configured URL carrying a path must not become the href — preconnect
    // takes an origin, and a path-bearing value would be a wrong-shaped hint.
    const tags = emit("https://id.musubi.social/authorize?x=1#f");
    expect(tags[0]!.attrs?.href).toBe("https://id.musubi.social");
  });

  it("goes in the head before anything that could start a request", () => {
    expect(emit("https://id.musubi.social")[0]!.injectTo).toBe("head-prepend");
  });

  it("emits nothing rather than a dead tag when the issuer is unset or malformed", () => {
    // Local dev leaves the var unset; the app falls back to localhost but the
    // plugin stays silent. Divergent, but in the safe direction.
    expect(emit(undefined)).toEqual([]);
    expect(emit("")).toEqual([]);
    expect(emit("not a url")).toEqual([]);
  });

  it("normalises a non-default port into the origin", () => {
    expect(emit("http://localhost:4000")[0]!.attrs?.href).toBe("http://localhost:4000");
  });
});
