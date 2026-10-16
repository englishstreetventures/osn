/**
 * Port preflight. The suite never reuses a server it did not start: a dev
 * server, another worktree's stack or a previous run's orphan on one of the
 * fixed ports would answer the flows with state the seed never wrote. So every
 * port is checked before anything spawns, and the run stops naming each one
 * that is taken.
 */

import { createConnection } from "node:net";

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
