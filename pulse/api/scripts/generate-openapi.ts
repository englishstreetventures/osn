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

// Even spelled correctly for 3.1, `anyOf: [X, { type: "null" }]` loses the
// field outright. swift-openapi-generator (via OpenAPIKit) has no
// representation for a `null` member of a union, warns
//
//   warning: Schema "null" is not supported, reason: "schema type", skipping
//
// and then omits the whole property from the generated Swift type. That is 254
// occurrences here — roughly half of every event field, `latitude` and
// `longitude` among them, silently absent from the client.
//
// The spelling it does understand is a type array: `type: ["number", "null"]`
// generates `Swift.Double?` with no warning, even for a `required` property.
// The two are equivalent in JSON Schema, so this rewrites one into the other.
//
// Three shapes occur, all handled here:
//   { anyOf: [{ type: "string" }, { type: "null" }] }
//     → { type: ["string", "null"] }
//   { anyOf: [{ anyOf: [{ const: "a" }, { const: "b" }] }, { type: "null" }] }
//   { anyOf: [{ const: "going" }, { const: "maybe" }, { type: "null" }] }
//     → { type: ["string", "null"], enum: ["a", "b"] }
//
// The const unions collapse to an `enum` because that is the only spelling a
// type array can carry, and it generates a far better type besides: a plain
// Swift enum, where an `anyOf` of consts generates a struct of one optional
// per member (`value1`, `value2`, …). Nothing regresses from that — every
// const union in this document sits inside a null union, so all of them are
// being dropped today anyway; the 96 unions the plugin already spells as
// `enum` are untouched.
//
// Anything that doesn't match a handled shape is left exactly as it was and
// reported, so a new route shape shows up as a warning here rather than as a
// field that quietly vanishes from the client.
function collapseNullUnions(node: unknown, unhandled: string[], path = "#"): void {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) {
      collapseNullUnions(child, unhandled, `${path}/${index}`);
    }
    return;
  }
  if (node === null || typeof node !== "object") return;

  // Depth first: a nested union has to be collapsed before its parent can
  // decide what it's looking at.
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    collapseNullUnions(child, unhandled, `${path}/${key}`);
  }

  const schema = node as Record<string, unknown>;
  const anyOf = schema["anyOf"];
  if (!Array.isArray(anyOf)) return;

  const isSchema = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isNullMember = (value: unknown) =>
    isSchema(value) && value["type"] === "null" && Object.keys(value).length === 1;

  if (!anyOf.some(isNullMember)) return;

  let members = anyOf.filter((member) => !isNullMember(member));
  // `t.Union([t.Literal(…)])` inside `t.Nullable(…)` nests one union in the
  // other; flatten it so both nesting depths reach the same branches below.
  const [only] = members;
  if (
    members.length === 1 &&
    isSchema(only) &&
    Array.isArray(only["anyOf"]) &&
    Object.keys(only).length === 1
  ) {
    members = only["anyOf"];
  }

  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf"));
  const replace = (replacement: Record<string, unknown>) => {
    for (const key of Object.keys(schema)) delete schema[key];
    Object.assign(schema, rest, replacement);
  };

  if (
    members.length > 0 &&
    members.every((member) => isSchema(member) && member["const"] !== undefined)
  ) {
    const first = members[0] as Record<string, unknown>;
    replace({
      type: [first["type"] ?? "string", "null"],
      enum: members.map((member) => (member as Record<string, unknown>)["const"]),
    });
    return;
  }

  const [single] = members;
  if (members.length === 1 && isSchema(single) && typeof single["type"] === "string") {
    replace({ ...single, type: [single["type"], "null"] });
    return;
  }

  unhandled.push(path);
}

// A route that names its response schema at the top level (`response: { 200:
// "Event" }`) gets a correct `#/components/schemas/Event` pointer from the
// plugin. A `t.Ref("Event")` *nested* inside a `t.Object` or `t.Array` does
// not: TypeBox stores the bare name it was given, and the plugin emits it
// verbatim as `{"$ref": "Event"}`. That is a valid JSON Schema `$ref` — it just
// resolves to nothing here — and swift-openapi-generator fails on the document.
//
// Elysia resolves either spelling at runtime, so the two are equivalent to the
// server and only the document needs correcting. Every name must match a
// component; an unresolvable one is a typo'd `t.Ref` and should stop the build
// rather than reach the generator.
function resolveBareRefs(doc: Record<string, unknown>): void {
  const components = doc["components"];
  const schemas =
    components !== null && typeof components === "object"
      ? (components as Record<string, unknown>)["schemas"]
      : undefined;
  const known = new Set(
    schemas !== null && typeof schemas === "object"
      ? Object.keys(schemas as Record<string, unknown>)
      : [],
  );

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    const ref = schema["$ref"];
    if (typeof ref === "string" && !ref.startsWith("#/")) {
      if (!known.has(ref)) {
        throw new Error(
          `$ref "${ref}" matches no entry in components/schemas — ` +
            `register it with \`.model({ ${ref}: … })\` on the route's Elysia instance.`,
        );
      }
      schema["$ref"] = `#/components/schemas/${ref}`;
    }
    for (const child of Object.values(schema)) walk(child);
  };
  walk(doc);
}

// The plugin stamps `"$id": "#/components/schemas/Event"` onto each component
// it hoists. `$id` is a JSON Schema identifier, not an OpenAPI schema keyword,
// and the value is a document pointer rather than the URI reference `$id` is
// defined to hold. It carries no information the component's key doesn't
// already give, so drop it.
function stripComponentIds(doc: Record<string, unknown>): void {
  const components = doc["components"];
  if (components === null || typeof components !== "object") return;
  const schemas = (components as Record<string, unknown>)["schemas"];
  if (schemas === null || typeof schemas !== "object") return;
  for (const schema of Object.values(schemas as Record<string, unknown>)) {
    if (schema === null || typeof schema !== "object") continue;
    delete (schema as Record<string, unknown>)["$id"];
  }
}

const app = createApp();
const res = await app.handle(new Request("http://localhost/openapi/json"));
if (!res.ok) {
  throw new Error(`GET /openapi/json returned ${res.status}`);
}
const doc = (await res.json()) as Record<string, unknown>;

resolveBareRefs(doc);
stripComponentIds(doc);

// Order matters: `stripRedundantNullable` looks for the `anyOf` that
// `collapseNullUnions` removes, so it has to run first.
stripRedundantNullable(doc);
const unhandledNullUnions: string[] = [];
collapseNullUnions(doc, unhandledNullUnions);
for (const path of unhandledNullUnions) {
  // eslint-disable-next-line no-console -- CLI script output
  console.warn(`warning: null union left as-is (unhandled shape) at ${path}`);
}

const output = `${JSON.stringify(sortKeys(stripVoidContent(doc)), null, 2)}\n`;

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, output, "utf-8");

// eslint-disable-next-line no-console -- CLI script output
console.log(`Wrote ${OUTPUT_PATH}`);
