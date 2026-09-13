import { describe, expect, it } from "vitest";

// Every other test here builds its own fixture, which answers whether a
// normaliser works on the shape it was written for. These open the two
// documents that actually ship and assert the properties the pipeline exists
// to guarantee — so a plugin that starts emitting a shape no normaliser knows
// about fails with the invariant it broke, rather than as an unexplained diff
// in the freshness job.
const documents = ["osn", "pulse"] as const;

const load = async (name: (typeof documents)[number]): Promise<unknown> =>
  (await import(`../../openapi/${name}.json`)).default;

const walk = (
  node: unknown,
  visit: (schema: Record<string, unknown>, path: string) => void,
  path = "#",
): void => {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, visit, `${path}/${i}`));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  visit(schema, path);
  for (const [key, child] of Object.entries(schema)) walk(child, visit, `${path}/${key}`);
};

const collect = (
  doc: unknown,
  predicate: (schema: Record<string, unknown>) => boolean,
): string[] => {
  const hits: string[] = [];
  walk(doc, (schema, path) => {
    if (predicate(schema)) hits.push(path);
  });
  return hits;
};

describe.each(documents)("the committed %s document", (name) => {
  it("carries no OpenAPI 3.0 `nullable` keyword", async () => {
    // 3.1 has no such keyword. swift-openapi-generator warns once per
    // occurrence and falls back, so these are dead weight at best.
    expect(collect(await load(name), (schema) => schema["nullable"] !== undefined)).toEqual([]);
  });

  it("expresses nullability as a type array, never an `anyOf` null member", async () => {
    // OpenAPIKit has no representation for a `null` member of a union: it
    // warns and omits the whole property from the generated Swift type.
    expect(
      collect(
        await load(name),
        (schema) =>
          Array.isArray(schema["anyOf"]) &&
          schema["anyOf"].some(
            (member) =>
              member !== null &&
              typeof member === "object" &&
              (member as Record<string, unknown>)["type"] === "null",
          ),
      ),
    ).toEqual([]);
  });

  it("carries no leftover `$id` on a component schema", async () => {
    expect(collect(await load(name), (schema) => schema["$id"] !== undefined)).toEqual([]);
  });

  it("declares an OpenAPI 3.1 version", async () => {
    // The plugin sets this itself and moved it 3.1.0 -> 3.1.2 in
    // @elysiajs/openapi 1.4.16, so pin the minor rather than the patch.
    const doc = (await load(name)) as { openapi?: string };
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
  });
});
