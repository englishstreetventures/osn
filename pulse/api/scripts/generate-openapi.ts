import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";

/**
 * Regenerates `shared/openapi/pulse.json` from the live route definitions.
 * Boots the real app (in-memory DB + rate limiters, matching test defaults)
 * and fetches its own `/openapi/json` rather than re-deriving the document
 * by hand, so the committed spec can never drift from what the app serves.
 */

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const OUTPUT_PATH = resolve(join(SCRIPT_DIR, "../../../shared/openapi/pulse.json"));

// Recursively sorts object keys so re-running the script on an unchanged
// route tree produces byte-identical output — required for the CI freshness
// check (`git diff --exit-code`) to be meaningful rather than flaky.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// `t.Void()` on a bodyless status (the 204s on DELETE /events/:id,
// POST /events/:id/share and POST /events/:id/exposure) makes
// @elysiajs/openapi emit `"content": { "type": "void" }`. A response's
// `content` must be a map of media type to media-type object, so that shape is
// invalid OpenAPI, and swift-openapi-generator rejects the entire document over
// it:
//
//   error: Expected `type` value in .content for the status code '204'
//   response of the DELETE endpoint under `/events/{id}` to be parsable as
//   Mapping but it was not.
//
// The fix cannot live on the route: whenever a route declares `response:`, the
// plugin discards `detail.responses` wholesale, so a 204 cannot be both
// validated by Elysia and hand-documented. Keep `t.Void()` for its runtime
// validation and drop the bogus `content` here — a bodyless response is
// correctly spelled as a description with no `content` at all.
function stripVoidContent(doc: Record<string, unknown>): Record<string, unknown> {
  const paths = doc["paths"];
  if (paths === null || typeof paths !== "object") return doc;
  for (const operations of Object.values(paths as Record<string, unknown>)) {
    if (operations === null || typeof operations !== "object") continue;
    for (const operation of Object.values(operations as Record<string, unknown>)) {
      if (operation === null || typeof operation !== "object") continue;
      const responses = (operation as Record<string, unknown>)["responses"];
      if (responses === null || typeof responses !== "object") continue;
      for (const response of Object.values(responses as Record<string, unknown>)) {
        if (response === null || typeof response !== "object") continue;
        const holder = response as Record<string, unknown>;
        const content = holder["content"];
        if (content === null || typeof content !== "object") continue;
        // A real `content` is keyed by media type, which always contains a
        // slash. Anything else is the plugin leaking a schema into that slot.
        const keys = Object.keys(content as Record<string, unknown>);
        if (keys.length > 0 && keys.every((key) => !key.includes("/"))) {
          delete holder["content"];
        }
      }
    }
  }
  return doc;
}

// `t.Nullable(...)` makes the plugin emit both spellings of nullability at
// once: the 3.1-correct `anyOf: [X, { type: "null" }]` *and* OpenAPI 3.0's
// `nullable: true` keyword, which does not exist in 3.1. The document declares
// 3.1.0, so the extra keyword is invalid — swift-openapi-generator emits one
// validation warning per occurrence (253 of them) before falling back to the
// `anyOf`. Drop `nullable` only where the union already carries `type: "null"`,
// so nullability is never silently lost.
function stripRedundantNullable(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) stripRedundantNullable(child);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  if (schema["nullable"] === true) {
    const anyOf = schema["anyOf"];
    const expressesNull =
      Array.isArray(anyOf) &&
      anyOf.some(
        (member) =>
          member !== null &&
          typeof member === "object" &&
          (member as Record<string, unknown>)["type"] === "null",
      );
    if (expressesNull) delete schema["nullable"];
  }
  for (const child of Object.values(schema)) stripRedundantNullable(child);
}

const app = createApp();
const res = await app.handle(new Request("http://localhost/openapi/json"));
if (!res.ok) {
  throw new Error(`GET /openapi/json returned ${res.status}`);
}
const doc = (await res.json()) as Record<string, unknown>;

stripRedundantNullable(doc);
const output = `${JSON.stringify(sortKeys(stripVoidContent(doc)), null, 2)}\n`;

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, output, "utf-8");

// eslint-disable-next-line no-console -- CLI script output
console.log(`Wrote ${OUTPUT_PATH}`);
