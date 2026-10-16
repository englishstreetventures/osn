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
