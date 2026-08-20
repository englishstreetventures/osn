/**
 * `DEV_APPS` and the twelve app `package.json`s both describe
 * the same devloop, and nothing but this file makes them agree.
 *
 * A rename in one place only is silent: the app's `PORTLESS_URL` stops
 * containing its own name, `splitHost` returns null, and it quietly falls back
 * to fixed ports while every other app still addresses it by hostname. Half a
 * devloop, no error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEV_APPS, type DevAppId } from "../src/index";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** Workspace directory for a package name: `@cire/host` → `cire/host`. */
const workspaceDir = (id: DevAppId) => id.replace(/^@/, "");

const readJson = (path: string) => JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf-8"));

const packageJson = (id: DevAppId) =>
  readJson(`${workspaceDir(id)}/package.json`) as {
    name: string;
    scripts: Record<string, string>;
    devDependencies?: Record<string, string>;
    portless?: { name?: string; script?: string };
  };

const ids = Object.keys(DEV_APPS) as DevAppId[];

describe("the portless key", () => {
  // It has to be here rather than in one root `portless.json`: portless reads
  // its config from the current directory only, and turbo runs each package's
  // `dev` script from that package's directory, so a root config is never seen.
  // Without it portless falls back to inferring the name from the package name,
  // which makes `@osn/api` and `@cire/api` both `api.localhost` — the second one
  // to start dies on "already registered".
  it("names every app the same as DEV_APPS", () => {
    for (const id of ids) {
      expect(packageJson(id).portless?.name).toBe(DEV_APPS[id].name);
    }
  });

  it("points every app at its dev:app script", () => {
    for (const id of ids) {
      expect(packageJson(id).portless?.script).toBe("dev:app");
    }
  });
});

describe("app package.json", () => {
  it("runs portless as dev and the real command through dev-env", () => {
    for (const id of ids) {
      const pkg = packageJson(id);
      expect(pkg.name).toBe(id);
      expect(pkg.scripts.dev).toBe("portless");
      expect(pkg.scripts["dev:app"]).toMatch(/^dev-env /);
    }
  });

  it("depends on @shared/dev-urls, which is what puts dev-env on PATH", () => {
    for (const id of ids) {
      expect(packageJson(id).devDependencies?.["@shared/dev-urls"]).toBe("workspace:*");
    }
  });
});

describe("DEV_APPS", () => {
  it("gives every app a distinct hostname", () => {
    const names = ids.map((id) => DEV_APPS[id].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every app a distinct fallback port, so PORTLESS=0 still works", () => {
    const ports = ids.map((id) => DEV_APPS[id].port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("uses hostname-safe labels", () => {
    for (const id of ids) {
      expect(DEV_APPS[id].name).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
    }
  });
});
