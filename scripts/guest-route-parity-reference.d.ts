// Types for scripts/guest-route-parity-reference.js, which stays JavaScript
// because it runs on Node: scripts/tsconfig.json type-checks only `.ts`
// files, and the tests and scripts/guest-route-parity.ts import it under Bun.

/** Whether the Worker's own request to cire-api carried a user agent: `present` or `absent`. */
export declare const WORKER_UA_HEADER: "x-parity-worker-ua";

/** The run's relay token, without which the relay serves nothing. */
export declare const RELAY_TOKEN_HEADER: "x-parity-relay-token";

export interface ForwardOptions {
  /** The cire-api origin the build calls; only a request to exactly it goes to the relay. */
  readonly apiOrigin: string;
  /** The relay's port on 127.0.0.1. */
  readonly relayPort: number;
  readonly token: string;
  readonly fetchImpl: (
    url: string,
    init: RequestInit & { readonly duplex: "half" },
  ) => Promise<Response>;
}

/** The function Miniflare hands every outbound request of the Worker to. */
export declare function makeForward(
  options: ForwardOptions,
): (request: Request) => Promise<Response>;
