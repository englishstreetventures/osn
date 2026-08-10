import { describe, expect, it } from "vitest";

import {
  collapseNullUnions,
  excludePaths,
  normalizeOpenApiDocument,
  resolveBareRefs,
  sortKeys,
  stripComponentIds,
  stripRedundantNullable,
  stripVoidContent,
} from "../src/normalize";

describe("sortKeys", () => {
  it("orders object keys so an unchanged route tree serialises identically", () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: { d: 2, c: 3 } }))).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order (position is meaning, not spelling)", () => {
    expect(sortKeys([3, 1, 2])).toEqual([3, 1, 2]);
  });
});

describe("stripVoidContent", () => {
  it("drops the bogus `content` a `t.Void()` 204 produces", () => {
    const doc = {
      paths: {
        "/events/{id}": {
          delete: { responses: { "204": { description: "", content: { type: "void" } } } },
        },
      },
    };
    stripVoidContent(doc);
    expect(doc.paths["/events/{id}"].delete.responses["204"]).toEqual({ description: "" });
  });

  it("leaves a real media-type map alone", () => {
    const content = { "application/json": { schema: { type: "object" } } };
    const doc = { paths: { "/x": { get: { responses: { "200": { content } } } } } };
    stripVoidContent(doc);
    expect(doc.paths["/x"].get.responses["200"].content).toBe(content);
  });
});

describe("stripRedundantNullable", () => {
  it("removes the 3.0 keyword when the union already says null", () => {
    const node = { nullable: true, anyOf: [{ type: "string" }, { type: "null" }] };
    stripRedundantNullable(node);
    expect(node).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("keeps `nullable` when nothing else expresses nullability", () => {
    const node = { nullable: true, type: "string" };
    stripRedundantNullable(node);
    expect(node).toEqual({ nullable: true, type: "string" });
  });
});

describe("collapseNullUnions", () => {
  const collapse = (node: unknown) => {
    const unhandled: string[] = [];
    collapseNullUnions(node, unhandled);
    return unhandled;
  };

  it("rewrites a plain null union as a type array", () => {
    const node = { anyOf: [{ type: "number" }, { type: "null" }] };
    expect(collapse(node)).toEqual([]);
    expect(node).toEqual({ type: ["number", "null"] });
  });

  it("collapses a flat const union to an enum", () => {
    const node = {
      anyOf: [{ const: "going" }, { const: "maybe" }, { type: "null" }],
    };
    expect(collapse(node)).toEqual([]);
    expect(node).toEqual({ type: ["string", "null"], enum: ["going", "maybe"] });
  });

  it("collapses a const union nested one level deeper", () => {
    const node = {
      anyOf: [{ anyOf: [{ const: "a" }, { const: "b" }] }, { type: "null" }],
    };
    expect(collapse(node)).toEqual([]);
    expect(node).toEqual({ type: ["string", "null"], enum: ["a", "b"] });
  });

  it("keeps sibling keywords through the rewrite", () => {
    const node = { description: "why", anyOf: [{ type: "string" }, { type: "null" }] };
    expect(collapse(node)).toEqual([]);
    expect(node).toEqual({ description: "why", type: ["string", "null"] });
  });

  it("leaves an unhandled shape untouched and reports its pointer", () => {
    const node = {
      properties: {
        weird: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
      },
    };
    expect(collapse(node)).toEqual(["#/properties/weird"]);
    expect(node.properties.weird.anyOf).toHaveLength(3);
  });

  it("ignores a union with no null member", () => {
    const node = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(collapse(node)).toEqual([]);
    expect(node.anyOf).toHaveLength(2);
  });
});

describe("resolveBareRefs", () => {
  it("expands a nested bare `$ref` to a document pointer", () => {
    const doc = {
      components: { schemas: { Event: { type: "object" } } },
      paths: { "/x": { get: { responses: { "200": { schema: { $ref: "Event" } } } } } },
    };
    resolveBareRefs(doc);
    expect(doc.paths["/x"].get.responses["200"].schema.$ref).toBe("#/components/schemas/Event");
  });

  it("throws on a name that matches no component", () => {
    const doc = { components: { schemas: {} }, paths: { "/x": { get: { $ref: "Nope" } } } };
    expect(() => resolveBareRefs(doc)).toThrow(/matches no entry in components\/schemas/);
  });

  it("leaves an already-resolved pointer alone", () => {
    const doc = { components: { schemas: {} }, paths: { $ref: "#/components/schemas/Event" } };
    resolveBareRefs(doc);
    expect(doc.paths.$ref).toBe("#/components/schemas/Event");
  });
});

describe("stripComponentIds", () => {
  it("drops the plugin's `$id` pointer from every component", () => {
    const doc = {
      components: { schemas: { Event: { $id: "#/components/schemas/Event", type: "object" } } },
    };
    stripComponentIds(doc);
    expect(doc.components.schemas.Event).toEqual({ type: "object" });
  });
});

describe("excludePaths", () => {
  function doc() {
    return {
      paths: {
        "/": {},
        "/graph/connections": {},
        "/graph/internal/connections": {},
        "/organisations/internal/membership": {},
        "/internal/step-up/verify": {},
      },
    };
  }

  it("drops every path a pattern matches and keeps the rest", () => {
    // The plugin's own `exclude.paths` matches with `Array.includes`, so a
    // RegExp there matches nothing — prefixes have to be dropped here.
    const d = doc();
    excludePaths(d, [/^\/graph\/internal\//, /^\/organisations\/internal\//, /^\/internal\//]);
    expect(Object.keys(d.paths)).toEqual(["/", "/graph/connections"]);
  });

  it("matches an exact string against the whole path, not as a prefix", () => {
    const d = doc();
    excludePaths(d, ["/graph"]);
    expect(Object.keys(d.paths)).toHaveLength(5);
  });

  it("leaves the document alone when given no patterns", () => {
    const d = doc();
    excludePaths(d, []);
    expect(Object.keys(d.paths)).toHaveLength(5);
  });

  it("tolerates a document with no `paths`", () => {
    expect(() => excludePaths({ openapi: "3.1.0" }, [/./])).not.toThrow();
  });
});

describe("normalizeOpenApiDocument", () => {
  it("runs `stripRedundantNullable` before the union collapse", () => {
    // If the order flipped, the `anyOf` would already be gone and `nullable`
    // would survive into the document as an invalid 3.1 keyword.
    const doc = {
      components: {
        schemas: {
          Event: {
            $id: "#/components/schemas/Event",
            properties: {
              lat: { nullable: true, anyOf: [{ type: "number" }, { type: "null" }] },
            },
          },
        },
      },
    };
    const { output, unhandledNullUnions } = normalizeOpenApiDocument(doc);
    expect(unhandledNullUnions).toEqual([]);
    expect(JSON.parse(output).components.schemas.Event).toEqual({
      properties: { lat: { type: ["number", "null"] } },
    });
  });

  it("ends with a newline so the file is diff-clean", () => {
    expect(normalizeOpenApiDocument({ openapi: "3.1.0" }).output.endsWith("\n")).toBe(true);
  });
});
