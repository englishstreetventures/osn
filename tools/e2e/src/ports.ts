/**
 * Port preflight. The suite never reuses a server it did not start: a dev
 * server, another worktree's stack or a previous run's orphan on one of the
 * fixed ports would answer the flows with state the seed never wrote. So every
 * port is checked before anything spawns, and the run stops naming each one
 * that is taken. Once the stack is up, the same probe checks that no API
 * answers at this machine's network address.
 */

import { createConnection } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

/** True when something accepts a TCP connection on `host:port`. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

/**
 * A port counts as taken when either loopback family answers: a server bound
 * to `::1` alone is invisible to an IPv4 probe, and the browser resolves
 * `localhost` to whichever answers first.
 */
export async function portInUse(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([answers("127.0.0.1", port), answers("::1", port)]);
  return v4 || v6;
}

/** Every `name → port` that is already taken. Empty means the stack can boot. */
export async function takenPorts(
  ports: Readonly<Record<string, number>>,
): Promise<Array<{ name: string; port: number }>> {
  const checks = await Promise.all(
    Object.entries(ports).map(async ([name, port]) => ({
      name,
      port,
      taken: await portInUse(port),
    })),
  );
  return checks.filter((c) => c.taken).map(({ name, port }) => ({ name, port }));
}

/**
 * This machine's first IPv4 address that is not loopback: where another
 * machine on the network would connect. Null on a machine with none.
 */
export function networkAddress(
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>,
): string | null {
  for (const addresses of Object.values(interfaces)) {
    const found = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (found) return found.address;
  }
  return null;
}

/**
 * Every `name → port` that accepts a connection at `address`. Given this
 * machine's network address, a server listening on loopback alone is never
 * named; one listening on every interface is.
 */
export async function answeringAt(
  address: string,
  ports: Readonly<Record<string, number>>,
): Promise<Array<{ name: string; port: number }>> {
  const checks = await Promise.all(
    Object.entries(ports).map(async ([name, port]) => ({
      name,
      port,
      open: await answers(address, port),
    })),
  );
  return checks.filter((c) => c.open).map(({ name, port }) => ({ name, port }));
}
