import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { API_COMMAND, appSpecs, baseEnv, INHERITED_ENV } from "../src/stack";

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

// In the run against Stripe's test mode, the real test key reaches one app:
// cire-api, which sends every call to Stripe itself. The key also sits in the
// launcher's own environment, which a child's environment is built from, so
// the shell filter is what keeps it out of every build and every other server.
describe("appSpecs in Stripe test mode", () => {
  const secretKey = ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
  const webhookSecret = ["whsec", "listenSessionValue"].join("_");
  const specs = appSpecs(undefined, { secretKey, webhookSecret });
  const byName = Object.fromEntries(specs.map((s) => [s.name, s.env]));

  test("cire-api holds the test key and the listen secret, and sends nothing to the stand-in", () => {
    const cire = byName["cireApi"] ?? {};
    expect(cire["STRIPE_SECRET_KEY"]).toBe(secretKey);
    expect(cire["STRIPE_WEBHOOK_SECRET"]).toBe(webhookSecret);
    for (const unset of [
      "STRIPE_API_URL",
      "STRIPE_CONNECT_URL",
      "STRIPE_CONNECT_CLIENT_ID",
      "STRIPE_UPGRADE_PRICE_GOLD",
      "STRIPE_PLATFORM_WEBHOOK_SECRET",
    ]) {
      expect(cire, unset).not.toHaveProperty(unset);
    }
  });

  test("no other app is given the key or the secret", () => {
    for (const spec of specs.filter((s) => s.name !== "cireApi")) {
      const values = Object.values(spec.env).join("\n");
      expect(values, spec.name).not.toContain(secretKey);
      expect(values, spec.name).not.toContain(webhookSecret);
    }
    expect(byName["cireApiKeyOnly"]?.["STRIPE_API_URL"]).toBe("http://localhost:4591");
  });

  test("a child's environment drops the key from the launcher's own", () => {
    const env = baseEnv({ PATH: "/usr/bin", STRIPE_TEST_SECRET_KEY: secretKey }, 0);
    expect(Object.values(env).join("\n")).not.toContain(secretKey);
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
  // every interface. An API package new to the stack needs an entry here. That
  // each server binds what it reads, the launcher checks on every run
  // (`apisOnLoopbackAlone` in `src/launcher.ts`).
  test("every API the stack starts is told to listen on loopback alone", () => {
    const hostnameVariable: Readonly<Record<string, string>> = {
      "osn/api": "OSN_LOCAL_HOSTNAME",
      "pulse/api": "PULSE_LOCAL_HOSTNAME",
      "cire/api": "CIRE_LOCAL_HOSTNAME",
    };
    const apis = appSpecs().filter((s) => s.command === API_COMMAND);
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
      // Code only: a name left in a comment is no read. The `:` keeps a URL's `//`.
      const code = readFileSync(join(REPO_ROOT, spec.dir, "src", "local.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(
        new RegExp(`\\bprocess\\.env\\.${variable}\\b`).test(code),
        `${spec.dir}/src/local.ts reads ${variable}`,
      ).toBe(true);
    }
  });
});
