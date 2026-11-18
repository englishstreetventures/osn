import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { answeringAt, networkAddress, takenPorts } from "../src/ports";

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

const loopback: NetworkInterfaceInfo = {
  address: "127.0.0.1",
  netmask: "255.0.0.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal: true,
  cidr: "127.0.0.1/8",
};
const lan: NetworkInterfaceInfo = {
  address: "192.0.2.20",
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "02:00:00:00:00:01",
  internal: false,
  cidr: "192.0.2.20/24",
};
const lanV6: NetworkInterfaceInfo = {
  address: "2001:db8::20",
  netmask: "ffff:ffff:ffff:ffff::",
  family: "IPv6",
  mac: "02:00:00:00:00:01",
  internal: false,
  cidr: "2001:db8::20/64",
  scopeid: 0,
};

describe("networkAddress", () => {
  test("is none on a machine with loopback alone, or nothing but IPv6 beyond it", () => {
    expect(networkAddress({ lo0: [loopback] })).toBeNull();
    expect(networkAddress({ lo0: [loopback], en0: [lanV6] })).toBeNull();
  });

  test("is the IPv4 address another machine on the network would connect to", () => {
    expect(networkAddress({ lo0: [loopback], en0: [lanV6, lan] })).toBe("192.0.2.20");
  });
});

// The launcher's check that every API listens on loopback alone. It needs an
// address of this machine that is not loopback; a machine with none skips it.
const here = networkAddress(networkInterfaces());

function listenOn(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  const held = createServer();
  return new Promise((done) =>
    held.listen(0, host, () => {
      const address = held.address();
      done({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => new Promise<void>((closed) => held.close(() => closed())),
      });
    }),
  );
}

describe("answeringAt", () => {
  test.skipIf(here === null)("names a server listening on every interface", async () => {
    const held = await listenOn("0.0.0.0");
    try {
      expect(await answeringAt(here ?? "", { osnApi: held.port })).toEqual([
        { name: "osnApi", port: held.port },
      ]);
    } finally {
      await held.close();
    }
  });

  test.skipIf(here === null)("passes a server listening on 127.0.0.1 alone", async () => {
    const held = await listenOn("127.0.0.1");
    try {
      expect(await answeringAt(here ?? "", { osnApi: held.port })).toEqual([]);
    } finally {
      await held.close();
    }
  });
});
