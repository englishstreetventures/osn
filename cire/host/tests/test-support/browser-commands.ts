import { defineBrowserCommand } from "@vitest/browser-playwright";

/**
 * Browser commands available to `*.browser.test.ts(x)` files.
 * The realtime commands run a WebSocket server in the same process for the
 * portal's push tests.
 *
 * A command runs in the Vitest **node** process with the Playwright `page`
 * handle, while the test body runs inside the browser. That split is why media
 * emulation has to be a command: `prefers-color-scheme` and
 * `prefers-reduced-motion` are properties of the browser context, so nothing
 * running inside the page can change them.
 *
 * The alternative — extra `browser.instances` entries — would run the *entire*
 * suite once per preference to test the handful of rules that care. A per-test
 * command keeps it to the tests that actually assert it.
 *
 * (Mirrors `cire/invites`'s command of the same name, with `colorScheme` added: the
 * portal ships two ramps, and the readable-ink contract has to hold in both.)
 *
 * Emulate media preferences for the remainder of the current test.
 *
 * Always restore them in an `afterEach` — the browser context is shared across
 * tests in a file, so a leaked preference silently changes every later
 * assertion. Headless Chromium's own defaults are `light` and `no-preference`.
 */
export const emulateMedia = defineBrowserCommand<
  [{ reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" | "no-preference" }]
>(async (ctx, options) => {
  await ctx.page.emulateMedia(options);
});

type RealtimeSocket = { send(frame: string): void; close(code?: number, reason?: string): void };
type RealtimeServer = { port: number; stop(closeActiveConnections?: boolean): void };
type BunRuntime = { serve(options: unknown): RealtimeServer };

const realtimeSockets = new Set<RealtimeSocket>();
let realtimeServer: RealtimeServer | undefined;

/**
 * Start a WebSocket server the portal's realtime client can reach from the
 * browser, answering `ping` as the hub does. It runs in the Vitest process,
 * which is Bun (`bunx --bun vitest`). Playwright's `routeWebSocket` is no
 * substitute: it patches a document as it loads, and the test iframe already
 * exists by the time a command runs.
 */
export const startRealtimeServer = defineBrowserCommand<[]>(async () => {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun)
    throw new Error("startRealtimeServer needs Bun: run the suite with `bunx --bun vitest`");
  realtimeServer ??= bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, server: { upgrade(request: Request): boolean }) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 426 });
    },
    websocket: {
      open(ws: RealtimeSocket) {
        realtimeSockets.add(ws);
      },
      message(ws: RealtimeSocket, frame: string) {
        if (frame === "ping") ws.send("pong");
      },
      close(ws: RealtimeSocket) {
        realtimeSockets.delete(ws);
      },
    },
  });
  return { port: realtimeServer.port };
});

/** Send one text frame to every socket the server holds. */
export const pushRealtime = defineBrowserCommand<[string]>(async (_ctx, frame) => {
  for (const ws of realtimeSockets) ws.send(frame);
});

/** Close every socket the server holds with `code`, as a deploy or eviction would. */
export const dropRealtime = defineBrowserCommand<[number]>(async (_ctx, code) => {
  for (const ws of realtimeSockets) ws.close(code, "test drop");
});

export const realtimeSocketCount = defineBrowserCommand<[]>(async () => realtimeSockets.size);

export const stopRealtimeServer = defineBrowserCommand<[]>(async () => {
  realtimeServer?.stop(true);
  realtimeServer = undefined;
  realtimeSockets.clear();
});

/**
 * Teach `commands` about the commands above.
 *
 * Vitest builds `commands` from the `BrowserCommands` interface, which only
 * knows its three built-ins — so without this augmentation every call site has
 * to cast, which is what `@cire/invites` does today. Declaring it once here keeps
 * the tests reading like ordinary code and means a renamed or re-shaped command
 * is a type error rather than a runtime `undefined is not a function`.
 */
declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMedia: (options: {
      reducedMotion?: "reduce" | "no-preference";
      colorScheme?: "light" | "dark" | "no-preference";
    }) => Promise<void>;
    startRealtimeServer: () => Promise<{ port: number }>;
    pushRealtime: (frame: string) => Promise<void>;
    dropRealtime: (code: number) => Promise<void>;
    realtimeSocketCount: () => Promise<number>;
    stopRealtimeServer: () => Promise<void>;
  }
}
