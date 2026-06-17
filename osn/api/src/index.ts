import { createApp } from "./app";
import { buildAppDeps, startBunServer } from "./local";

// Bun composition entry. Tests import `{ app }` from here. The env-driven
// wiring + Effect layer graph (built ONCE — CLAUDE.md > Effect runtime) lives in
// `local.ts`; `createApp` in `app.ts` is the pure factory that knows nothing
// about `process.env`. This split de-risks the later Cloudflare Workers entry
// (`export default { fetch }`), which will reuse `createApp` with its own
// binding-driven deps.
const built = await buildAppDeps();
const app = createApp(built.deps);

if (process.env.NODE_ENV !== "test") {
  startBunServer(app, built);
}

export { app };
export type App = typeof app;
