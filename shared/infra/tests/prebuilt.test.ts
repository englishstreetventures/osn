import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { readPrebuiltWorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Prebuilt";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  planPrebuiltStage,
  PREBUILT_MODULE_RULES,
  PrebuiltSourceMapError,
  PrebuiltWorkerError,
  writePrebuiltStage,
} from "../src/prebuilt";

/** Bytes no text round trip keeps: a NUL, a lone continuation byte, a CRLF. */
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x80, 0xff, 0x0d, 0x0a]);

const map = (fields: Record<string, unknown>): string =>
  JSON.stringify({ version: 3, names: [], mappings: "AAAA", ...fields });

/**
 * A server directory shaped like the guest site's: an entry and chunks with
 * maps beside them, a chunk with none, a map no module names, the adapter's
 * `wrangler.json`, `wrangler dev`'s `.wrangler/tmp`, and a module under
 * another dot directory, which Wrangler uploads.
 */
const FILES: Readonly<Record<string, string | Uint8Array>> = {
  "entry.mjs": "import './chunks/a.mjs';\nexport default {};\n//# sourceMappingURL=entry.mjs.map\n",
  "entry.mjs.map": map({
    file: "entry.mjs",
    sources: ["../../src/entry.ts"],
    sourcesContent: ["export default {}"],
  }),
  // A debugId line after the map comment, as some bundlers write.
  "chunks/a.mjs": "export const a = 1;\n//# sourceMappingURL=a.mjs.map\n//# debugId=0000\n",
  "chunks/a.mjs.map": map({
    file: "a.mjs",
    sourceRoot: "./",
    sources: ["../../../src/a.ts", ".././x.ts"],
  }),
  "chunks/b.mjs": "export const b = 2;\n",
  "chunks/c.wasm": WASM,
  "chunks/orphan.mjs.map": map({ file: "orphan.mjs", sources: ["../src/orphan.ts"] }),
  "wrangler.json": "{}",
  ".wrangler/tmp/bundle.js": "export const stale = true;\n",
  ".prerender/page.mjs": "export const page = 1;\n",
};

function fixture(files: Readonly<Record<string, string | Uint8Array>> = FILES): {
  readonly source: string;
  readonly target: string;
} {
  const root = mkdtempSync(join(tmpdir(), "prebuilt-"));
  const source = join(root, "dist", "server");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  const target = join(root, ".generated", "invites-server");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "stale.mjs"), "export const stale = true;\n");
  return { source, target };
}

const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .toSorted();

const staged = (files?: Readonly<Record<string, string | Uint8Array>>) => {
  const { source, target } = fixture(files);
  writePrebuiltStage(planPrebuiltStage({ source, main: "entry.mjs" }), target);
  return { source, target };
};

const mapAt = (target: string, path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(target, path), "utf8")) as Record<string, unknown>;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("planPrebuiltStage and writePrebuiltStage", () => {
  test("ST-a: copies every module byte for byte, binary ones included", () => {
    const { source, target } = staged();
    for (const path of ["entry.mjs", "chunks/a.mjs", "chunks/b.mjs", "chunks/c.wasm"]) {
      expect(readFileSync(join(target, path)).equals(readFileSync(join(source, path)))).toBe(true);
    }
  });

  test("ST-b: writes each map as Wrangler uploads it: file is the module's path, sources and sourceRoot lose their leading ./ and ../", () => {
    const { target } = staged();
    expect(mapAt(target, "entry.mjs.map")).toMatchObject({
      file: "entry.mjs",
      sources: ["src/entry.ts"],
      sourcesContent: ["export default {}"],
    });
    expect(mapAt(target, "chunks/a.mjs.map")).toMatchObject({
      file: "chunks/a.mjs",
      sourceRoot: "",
      sources: ["src/a.ts", "./x.ts"],
    });
  });

  test("ST-c: leaves out a map no module names", () => {
    const { target } = staged();
    expect(listing(target)).not.toContain("chunks/orphan.mjs.map");
  });

  test("ST-d: refuses a module whose map comment names a missing file, naming the module, before anything is written", () => {
    const { source } = fixture({
      ...FILES,
      "chunks/b.mjs": "1;\n//# sourceMappingURL=gone.mjs.map\n",
    });
    const error = thrown(() => planPrebuiltStage({ source, main: "entry.mjs" }));
    expect(error).toBeInstanceOf(PrebuiltSourceMapError);
    expect(error).toMatchObject({ module: "chunks/b.mjs" });
  });

  test("ST-e: refuses a map inlined as a data: URL", () => {
    const { source } = fixture({
      ...FILES,
      "chunks/b.mjs": "1;\n//# sourceMappingURL=data:application/json;base64,e30=\n",
    });
    expect(() => planPrebuiltStage({ source, main: "entry.mjs" })).toThrow(PrebuiltSourceMapError);
  });

  test("ST-f: leaves out wrangler dev's top-level .wrangler, and keeps a module under any other dot directory, as Wrangler does", () => {
    const { target } = staged();
    expect(listing(target).filter((path) => path.startsWith(".wrangler"))).toEqual([]);
    expect(listing(target)).toContain(join(".prerender", "page.mjs"));
  });

  test("ST-g: empties the target first, so nothing an earlier run staged survives", () => {
    const { target } = staged();
    expect(listing(target)).not.toContain("stale.mjs");
  });

  test("ST-h: stages modules and their maps and nothing else, and refuses an entry that is not there", () => {
    const { source, target } = staged();
    expect(listing(target)).toEqual(
      [
        ".prerender/page.mjs",
        "chunks/a.mjs",
        "chunks/a.mjs.map",
        "chunks/b.mjs",
        "chunks/c.wasm",
        "entry.mjs",
        "entry.mjs.map",
      ].map((path) => join(...path.split("/"))),
    );
    const error = thrown(() => planPrebuiltStage({ source, main: "server.mjs" }));
    expect(error).toBeInstanceOf(PrebuiltWorkerError);
    expect((error as Error).message).toContain("server.mjs");
  });

  test("ST-i: finds the map comment above trailing //# lines, and strips path prefixes in Wrangler's order", () => {
    const { target } = staged();
    // `.././x.ts` loses only its `../`: Wrangler strips `./`, `.\`, `../`, `..\` in that nested order.
    expect(mapAt(target, "chunks/a.mjs.map").sources).toEqual(["src/a.ts", "./x.ts"]);
  });

  test("refuses a target that overlaps the source, which emptying it would delete", () => {
    const { source } = fixture();
    const stage = planPrebuiltStage({ source, main: "entry.mjs" });
    expect(() => writePrebuiltStage(stage, join(source, "staged"))).toThrow(PrebuiltWorkerError);
    expect(() => writePrebuiltStage(stage, dirname(source))).toThrow(PrebuiltWorkerError);
  });

  test("SM1: Alchemy's own prebuilt reader, with the prebuilt module rules, uploads the staged modules and maps, entry first", async () => {
    const { target } = staged();
    const bundle = await Effect.runPromise(
      readPrebuiltWorkerBundle({
        main: join(target, "entry.mjs"),
        rules: [...PREBUILT_MODULE_RULES],
      }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(bundle.files.map((file) => file.path)).toEqual([
      "entry.mjs",
      ".prerender/page.mjs",
      "chunks/a.mjs",
      "chunks/a.mjs.map",
      "chunks/b.mjs",
      "chunks/c.wasm",
      "entry.mjs.map",
    ]);
  });
});
