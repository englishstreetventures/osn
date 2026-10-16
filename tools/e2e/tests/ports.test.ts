import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";

import { takenPorts } from "../src/ports";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
});

function listenOnEphemeralPort(): Promise<number> {
  return new Promise((done) => {
    server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      done(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("takenPorts", () => {
  test("names a port something already listens on", async () => {
    const port = await listenOnEphemeralPort();
    expect(await takenPorts({ osnApi: port })).toEqual([{ name: "osnApi", port }]);
  });

  test("passes a port nothing listens on", async () => {
    const port = await listenOnEphemeralPort();
    await new Promise<void>((done) => server?.close(() => done()));
    server = null;
    expect(await takenPorts({ osnApi: port })).toEqual([]);
  });
});

// Vite and Astro bind `localhost`, which resolves to `::1` on some hosts; a
// stale frontend there answers only the IPv6 probe.
const ipv6Port = await new Promise<number | null>((done) => {
  const probe = createServer();
  probe.once("error", () => done(null));
  probe.listen(0, "::1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : null;
    probe.close(() => done(port));
  });
});

describe("takenPorts on IPv6", () => {
  test.skipIf(ipv6Port === null)("names a port held on ::1 alone", async () => {
    const held = createServer();
    const port = await new Promise<number>((done) =>
      held.listen(0, "::1", () => {
        const address = held.address();
        done(typeof address === "object" && address ? address.port : 0);
      }),
    );
    try {
      expect(await takenPorts({ musubi: port })).toEqual([{ name: "musubi", port }]);
    } finally {
      await new Promise<void>((done) => held.close(() => done()));
    }
  });
});
