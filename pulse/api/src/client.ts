import { treaty, type Treaty } from "@elysiajs/eden";

import type { App } from "./index";

/**
 * `config` is Eden's own treaty config — `{ fetch: { credentials: "include" } }`
 * is what a browser caller needs, since Pulse authenticates it with a session
 * cookie the default `same-origin` fetch mode would never send to the API host.
 */
export const createClient = (baseUrl: string, config?: Treaty.Config): Treaty.Create<App> =>
  treaty<App>(baseUrl, config);
