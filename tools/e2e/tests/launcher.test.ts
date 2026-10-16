import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { clockReaches, prepareRun } from "../src/launcher";
import { baseEnv } from "../src/stack";

// The clock reaching both runtimes is what keeps the seeded RSVP deadline open
// and "starts in the future" true on every run, whatever the real date.
describe("clockReaches", () => {
  test("both runtimes report the suite clock under the children's environment", () => {
    expect(clockReaches(baseEnv(process.env, Date.now()))).toEqual([]);
  });

  test("reports every trap in each runtime the clock did not reach", () => {
    const env = baseEnv(process.env, Date.now());
    delete env["E2E_CLOCK_T0"];
    const failures = clockReaches(env);
    for (const runtime of ["bun", "node"]) {
      for (const trap of ["Date.now()", "new Date()", "Date()"]) {
        expect(failures.some((f) => f.startsWith(`${runtime}: ${trap} is`))).toBe(true);
      }
    }
  });

  test("sees a clock that moves Date.now() but not new Date() or Date()", () => {
    const env = baseEnv(process.env, Date.now());
    env["NODE_OPTIONS"] = `--import ${resolve(import.meta.dirname, "support/now-only-clock.mjs")}`;
    const nodeFailures = clockReaches(env).filter((f) => f.startsWith("node:"));
    expect(nodeFailures.some((f) => f.startsWith("node: new Date() is"))).toBe(true);
    expect(nodeFailures.some((f) => f.startsWith("node: Date() is"))).toBe(true);
    expect(nodeFailures.some((f) => f.startsWith("node: Date.now() is"))).toBe(false);
  });
});

describe("prepareRun", () => {
  const listen = (): Promise<Server> =>
    new Promise((done) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => done(server));
    });
  const portOf = (server: Server): number => {
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  };

  test("a refused run names the port and leaves the last run's artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-prepare-"));
    const sentinel = join(dir, "results.json");
    writeFileSync(sentinel, "last run");
    const server = await listen();
    try {
      const taken = await prepareRun({ osnApi: portOf(server) }, dir, [join(dir, "state")]);
      expect(taken).toEqual([{ name: "osnApi", port: portOf(server) }]);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("with every port free it clears the directory and makes the subdirectories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-prepare-"));
    const sentinel = join(dir, "results.json");
    writeFileSync(sentinel, "last run");
    const server = await listen();
    const port = portOf(server);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await prepareRun({ osnApi: port }, dir, [join(dir, "state")])).toEqual([]);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(dir, "state"))).toBe(true);
  });
});
