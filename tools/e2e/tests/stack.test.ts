import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appSpecs, baseEnv, INHERITED_ENV } from "../src/stack";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("baseEnv", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    OSN_DATABASE_URL: "/home/dev/osn.db",
    OSN_ENV: "production",
    NODE_ENV: "test",
    CLAUDECODE: "1",
    TURNSTILE_SECRET_KEY: "real-secret",
    DEV_LOGIN_SECRET: "x",
  };

  test("passes only allowlisted shell variables through", () => {
    const env = baseEnv(shell, 0);
    const harnessKeys = Object.keys(baseEnv({}, 0));
    for (const key of Object.keys(env)) {
      expect([...INHERITED_ENV, ...harnessKeys]).toContain(key);
    }
    expect(env["PATH"]).toBe("/usr/bin");
    for (const leaked of [
      "OSN_DATABASE_URL",
      "OSN_ENV",
      "NODE_ENV",
      "CLAUDECODE",
      "DEV_LOGIN_SECRET",
    ]) {
      expect(env).not.toHaveProperty(leaked);
    }
  });

  test("blanks every CAPTCHA key, overriding the shell", () => {
    const env = baseEnv(shell, 0);
    expect(env["TURNSTILE_SECRET_KEY"]).toBe("");
    expect(env["VITE_TURNSTILE_SITEKEY"]).toBe("");
    expect(env["PUBLIC_TURNSTILE_SITEKEY"]).toBe("");
  });
});

describe("appSpecs", () => {
  test("every frontend is told its API origin, so no .env file can redirect it", () => {
    const byName = Object.fromEntries(appSpecs().map((s) => [s.name, s.env]));
    expect(byName["musubi"]?.["VITE_OSN_ISSUER_URL"]).toBe("http://localhost:4000");
    expect(byName["pulseWeb"]?.["VITE_API_URL"]).toBe("http://localhost:3001");
    expect(byName["cireInvites"]?.["PUBLIC_API_URL"]).toBe("http://localhost:8787");
    expect(byName["cireHost"]?.["PUBLIC_CIRE_API_URL"]).toBe("http://localhost:8787");
  });

  test("osn-api comes up before pulse-api, which registers its key with it at boot", () => {
    const order = appSpecs().map((s) => s.name);
    expect(order.indexOf("osnApi")).toBeLessThan(order.indexOf("pulseApi"));
  });

  test("Musubi is the first allowed origin, where osn-api sends an /authorize that needs the user", () => {
    const osn = appSpecs().find((s) => s.name === "osnApi");
    expect(osn?.env["OSN_ORIGIN"]?.split(",")[0]).toBe("http://localhost:1422");
  });

  // The APIs hold secrets committed to the repository as placeholders, so
  // nothing another machine sends may reach them. Each package's `src/local.ts`
  // reads its own variable for the address to listen on; unset, it listens on
  // every interface. An API package new to the stack needs an entry here.
  test("every API the stack starts listens on loopback alone", () => {
    const hostnameVariable: Readonly<Record<string, string>> = {
      "osn/api": "OSN_LOCAL_HOSTNAME",
      "pulse/api": "PULSE_LOCAL_HOSTNAME",
      "cire/api": "CIRE_LOCAL_HOSTNAME",
    };
    const apis = appSpecs().filter((s) => s.dir.endsWith("/api"));
    expect(apis.map((s) => s.name).toSorted()).toEqual([
      "cireApi",
      "cireApiKeyOnly",
      "osnApi",
      "osnApiEvt",
      "pulseApi",
    ]);
    for (const spec of apis) {
      const variable = hostnameVariable[spec.dir];
      expect(variable, `${spec.dir} has a hostname variable`).toBeDefined();
      expect(spec.env[variable ?? ""], `${spec.name} ${variable}`).toBe("127.0.0.1");
      const local = readFileSync(join(REPO_ROOT, spec.dir, "src", "local.ts"), "utf8");
      expect(
        local.includes(`process.env.${variable}`),
        `${spec.dir}/src/local.ts reads ${variable}`,
      ).toBe(true);
    }
  });
});
