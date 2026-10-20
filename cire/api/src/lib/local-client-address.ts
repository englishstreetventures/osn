/**
 * The client address the local dev server (`src/local.ts`) hands cire-api, in
 * the `cf-connecting-ip` header Cloudflare sets at the edge in production.
 *
 * Local dev has no edge, so the header is absent, and the fail-closed rate
 * limiter would answer 429 on every gated route (claim, preview-code,
 * account-link, invite writes). The socket peer stands in for it.
 *
 * Every per-address limiter keys on this header, so an address the request
 * sent itself is replaced: a caller does not choose its own key. The one
 * exception is `keepSent`, which only the E2E stack sets
 * (`CIRE_E2E_CLIENT_ADDRESS=1`), so a flow can send an organiser's claim from
 * the organiser's own address. A missing address is filled either way.
 *
 * The deployed Worker (`src/index.ts`) never calls this: the edge sets the
 * header there, and nothing a client sends survives it.
 */
export function localClientAddress(headers: Headers, peer: string, keepSent: boolean): Headers {
  const out = new Headers(headers);
  if (!keepSent || !out.has("cf-connecting-ip")) out.set("cf-connecting-ip", peer);
  return out;
}
