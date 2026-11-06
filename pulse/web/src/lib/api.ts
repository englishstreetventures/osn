import { createClient } from "@pulse/api/client";

import { dataBase, transportFetch } from "./transport";

/**
 * The Eden client for pulse-api's data routes. It is built with no host of its
 * own (`keepDomain` and an empty base), so each call's path is joined to
 * `dataBase()` when the call is made: the web origin's `/api` mount in the
 * browser, pulse-api itself on the rendering server. `transportFetch` carries
 * the session cookie on both.
 */
export const api: ReturnType<typeof createClient> = createClient("", {
  keepDomain: true,
  // Eden types its `fetcher` as the global `fetch`, which under bun-types also
  // carries `preconnect`; it only ever calls it.
  fetcher: ((path: string, init?: RequestInit) =>
    transportFetch(`${dataBase()}${path}`, init)) as typeof fetch,
});
