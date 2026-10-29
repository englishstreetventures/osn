/**
 * The repository patches alchemy's asset upload
 * (`patches/alchemy@2.0.0-beta.83.patch`) so every file uploads with the
 * content type Wrangler gives it: workers-shared's `getContentType`, which is
 * mime 4.0.7's type with `; charset=utf-8` added to any `text/*` type without
 * one, and `application/null` — which Cloudflare serves with no Content-Type
 * — for a name mime has no type for. The type is part of each file's manifest
 * hash, so a file whose type changes is a new blob and uploads again. Each
 * case runs against alchemy's `src/` copy, which Bun loads in a deploy, and
 * its `lib/` copy, which Node-style resolution loads, so this file fails if
 * the patch stops applying to either.
 *
 * It reads outside this package: the public directories of the sites Alchemy
 * uploads, and the wrangler cire/invites deploys with (`READS_REPO`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import mime from "mime";
import { describe, expect, test } from "vitest";

import { alchemyDir } from "./support/alchemy-dir";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(packageDir, "..", "..");

/** The part of alchemy's `Cloudflare/Workers/Assets` module this file drives. */
interface AssetsModule {
  readonly contentTypesByExtension: Readonly<Record<string, string>>;
  readonly getContentType: (name: string) => string;
  readonly readAssets: (props: { readonly directory: string }) => Effect.Effect<
    {
      readonly manifest: Readonly<Record<string, { readonly hash: string; readonly size: number }>>;
    },
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

/** Both copies alchemy ships. A computed path keeps the type-checker out of alchemy's source. */
const COPIES = [
  { copy: "src", path: "src/Cloudflare/Workers/Assets.ts" },
  { copy: "lib", path: "lib/Cloudflare/Workers/Assets.js" },
] as const;

const ALCHEMY_DIR = alchemyDir();

const load = (path: string): Promise<AssetsModule> =>
  import(/* @vite-ignore */ join(ALCHEMY_DIR, path)) as Promise<AssetsModule>;

/** What Wrangler uploads `path` as: workers-shared's `getContentType`, and the upload's fallback. */
function wranglerType(path: string): string {
  const type = mime.getType(path);
  if (type === null) return "application/null";
  return type.startsWith("text/") && !type.includes("charset") ? `${type}; charset=utf-8` : type;
}

/** The public directory of every asset site Alchemy uploads, on either tier. */
const PUBLIC_DIRS = [
  "cire/host/public",
  "cire/vendor/public",
  "cire/landing/public",
  "cire/invites/public",
  "musubi/social/public",
  "musubi/landing/public",
  "pulse/landing/public",
];

/** The extensions those sites' builds emit beside what their public directories hold. */
const EMITTED = [
  "html",
  "css",
  "js",
  "mjs",
  "map",
  "json",
  "woff",
  "woff2",
  "ttf",
  "svg",
  "png",
  "jpg",
  "webp",
  "avif",
  "ico",
  "txt",
  "xml",
  "webmanifest",
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

/** A file's extension as mime reads it: after the last dot of its name, when the name has one past its first character. */
function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

const sha256Prefix = (...parts: readonly (Uint8Array | string)[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex").slice(0, 32);
};

describe.each(COPIES)("alchemy's $copy copy", ({ path }) => {
  test("AC1: every extension in its table uploads as Wrangler uploads it; .ico as image/vnd.microsoft.icon, and .txt with a charset", async () => {
    const assets = await load(path);
    const extensions = Object.keys(assets.contentTypesByExtension);
    expect(extensions.length).toBeGreaterThan(30);
    for (const extension of extensions) {
      const name = `/dir/file.${extension}`;
      expect({ [extension]: assets.getContentType(name) }).toEqual({
        [extension]: wranglerType(name),
      });
    }
    expect(assets.getContentType("/favicon.ico")).toBe("image/vnd.microsoft.icon");
    expect(assets.getContentType("/robots.txt")).toBe("text/plain; charset=utf-8");
    expect(assets.getContentType("/privacy/index.html")).toBe("text/html; charset=utf-8");
    expect(assets.getContentType("/_astro/a.CSS")).toBe("text/css; charset=utf-8");
    expect(assets.getContentType("/_astro/a.js")).toBe("text/javascript; charset=utf-8");
    expect(assets.getContentType("/dump.sql")).toBe("application/sql");
  });

  test("AC2: a name with an extension mime does not know, or with none, uploads as application/null", async () => {
    const assets = await load(path);
    for (const name of [
      "/a.no-such-extension",
      "/README",
      "/.well-known/apple-app-site-association",
      "/v1.2/LICENSE",
      "/.json",
    ]) {
      expect({ [name]: assets.getContentType(name) }).toEqual({ [name]: "application/null" });
      expect({ [name]: wranglerType(name) }).toEqual({ [name]: "application/null" });
    }
  });

  test("AC3: a file's manifest hash covers the type it uploads with, so a changed type uploads again", async () => {
    const assets = await load(path);
    const dir = mkdtempSync(join(tmpdir(), "assets-content-type-"));
    const icon = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
    writeFileSync(join(dir, "favicon.ico"), icon);
    writeFileSync(join(dir, "robots.txt"), "User-agent: *\n");
    const { manifest } = await Effect.runPromise(
      assets.readAssets({ directory: dir }).pipe(Effect.provide(BunServices.layer)),
    );
    const iconHash = manifest["/favicon.ico"]?.hash;
    expect(iconHash).toBe(sha256Prefix(icon, "ico", "image/vnd.microsoft.icon"));
    // The hash alchemy gave the same bytes before the type entered it.
    expect(iconHash).not.toBe(sha256Prefix(icon, "ico"));
    expect(manifest["/robots.txt"]?.hash).toBe(
      sha256Prefix("User-agent: *\n", "txt", "text/plain; charset=utf-8"),
    );
  });

  test("AC6: every extension in an Alchemy asset site's public directory, and every one their builds emit, uploads as Wrangler uploads it", async () => {
    const assets = await load(path);
    const extensions = new Set(EMITTED);
    for (const dir of PUBLIC_DIRS) {
      const at = join(repoRoot, dir);
      expect({ [dir]: existsSync(at) }).toEqual({ [dir]: true });
      for (const file of filesUnder(at)) {
        const extension = extensionOf(file);
        if (extension !== "") extensions.add(extension);
      }
    }
    for (const extension of extensions) {
      const name = `/dir/file.${extension}`;
      expect({ [extension]: assets.getContentType(name) }).toEqual({
        [extension]: wranglerType(name),
      });
    }
  });
});

describe("the wrangler cire/invites deploys with", () => {
  test("AC5: it and its Miniflare still type every upload with mime 4.0.7 and the charset rule", () => {
    const cli = createRequire(join(repoRoot, "cire", "invites", "package.json")).resolve(
      "wrangler",
    );
    const miniflare = createRequire(cli).resolve("miniflare");
    for (const bundle of [cli, miniflare]) {
      const text = readFileSync(bundle, "utf8");
      expect({
        [bundle]: text.includes("/mime@4.0.7/node_modules/mime/dist/src/index.js"),
      }).toEqual({ [bundle]: true });
      expect(text).toContain(
        'contentType && contentType.startsWith("text/") && !contentType.includes("charset")',
      );
      expect(text).toContain("contentType = `${contentType}; charset=utf-8`;");
    }
    expect(readFileSync(cli, "utf8")).toContain(
      'type: getContentType(absFilePath) ?? "application/null"',
    );
    // The mime this file compares with is the one those bundles carry.
    const own = JSON.parse(
      readFileSync(
        createRequire(join(packageDir, "index.js")).resolve("mime/package.json"),
        "utf8",
      ),
    ) as { readonly version: string };
    expect(own.version).toBe("4.0.7");
  });
});
