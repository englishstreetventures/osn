import { deflateSync } from "node:zlib";

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
  [
    {
      reducedMotion?: "reduce" | "no-preference";
      colorScheme?: "light" | "dark" | "no-preference";
      /** `print` lays the page out as it prints; `null` puts the screen back. */
      media?: "print" | "screen" | null;
    },
  ]
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
 * Answer every request to `https://photos.example/<name>.png` with a generated
 * stand-in photo: a soft two-tone portrait of a head and shoulders, its hue
 * picked from the name.
 *
 * The portal draws a person's photo only from an https URL, and the test page
 * is served over http by Vite, so no file of the page's own can stand in. This
 * routes a fixed https origin to pictures made here instead — nothing leaves
 * the machine, and every run paints the same pixels. Routes last for the rest
 * of the browser context; call it once per test that wants photos.
 */
export const servePhotos = defineBrowserCommand<[]>(async (ctx) => {
  await ctx.page.route("https://photos.example/**", async (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\/|\.png$/g, "");
    await route.fulfill({ status: 200, contentType: "image/png", body: standInPhoto(name) });
  });
});

/** A 96px square portrait for `name`, as PNG bytes. */
function standInPhoto(name: string): Buffer {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = (hash % 360) / 360;
  const size = 96;
  const ground = hsl(hue, 0.42, 0.7);
  const figure = hsl((hue + 0.08) % 1, 0.32, 0.36);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const at = y * (size * 3 + 1);
    raw[at] = 0;
    for (let x = 0; x < size; x++) {
      const head = Math.hypot(x - 48, y - 38) < 19;
      const shoulders = y > 62 && Math.hypot((x - 48) / 1.55, y - 104) < 36;
      const shade = 1 - (y / size) * 0.18;
      const [r, g, b] = head || shoulders ? figure : ground.map((c) => c * shade);
      raw[at + 1 + x * 3] = r;
      raw[at + 2 + x * 3] = g;
      raw[at + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, body, tail]);
}

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
      media?: "print" | "screen" | null;
    }) => Promise<void>;
    servePhotos: () => Promise<void>;
    startRealtimeServer: () => Promise<{ port: number }>;
    pushRealtime: (frame: string) => Promise<void>;
    dropRealtime: (code: number) => Promise<void>;
    realtimeSocketCount: () => Promise<number>;
    stopRealtimeServer: () => Promise<void>;
  }
}
