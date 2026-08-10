import { createClient } from "@pulse/api/client";

import { PULSE_API_URL } from "./auth";

/**
 * `credentials: "include"` on every call — the API lives on a different host
 * from the web origin, and the default `same-origin` mode would silently drop
 * the session cookie, leaving every authenticated read looking signed-out.
 */
export const api: ReturnType<typeof createClient> = createClient(PULSE_API_URL, {
  fetch: { credentials: "include" },
});
