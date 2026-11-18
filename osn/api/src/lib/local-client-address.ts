import { isValidIp } from "@shared/rate-limit";

/** What Bun's `server.requestIP` answers for a request. */
export type RequestAddress = { address: string; family: "IPv4" | "IPv6"; port: number } | null;

/**
 * A `server.requestIP` for osn-api's local Bun server that keeps a client
 * address the request sends in `cf-connecting-ip`, as Cloudflare's edge sets
 * it in production, and answers the socket peer otherwise.
 *
 * Every per-address limiter keys on this address, so only the E2E stack turns
 * it on (`OSN_E2E_CLIENT_ADDRESS=1`, `src/local.ts`): a flow can then spend
 * its own limiter windows rather than the suite's one. Without the flag the
 * local server keys on the socket peer and a caller does not choose its own
 * key. A sent value that is not one well-formed address is ignored. The
 * deployed Worker (`src/index.ts`) never calls this.
 */
export function keepSentClientAddress(
  peer: (request: Request) => RequestAddress,
): (request: Request) => RequestAddress {
  return (request) => {
    const sent = request.headers.get("cf-connecting-ip")?.trim();
    if (sent && isValidIp(sent)) {
      return { address: sent, family: sent.includes(":") ? "IPv6" : "IPv4", port: 0 };
    }
    return peer(request);
  };
}
