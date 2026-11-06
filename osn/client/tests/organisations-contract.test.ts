/**
 * The organisations client against the API's own description of itself,
 * `shared/openapi/osn.json`, which CI regenerates from the routes and fails on
 * any difference. Every call the client makes must reach a route the spec has,
 * with query keys and a body the route accepts, and the types the client declares must name
 * the fields the routes answer with.
 *
 * Field names are kept in `Record<keyof T, true>` literals: the type checker
 * holds each literal to its interface, and this file holds it to the spec.
 * Names only — not types or nullability.
 *
 * Reads a file outside the package, so it runs as the `repo` project
 * (`test:repo`), which turbo reruns when the spec changes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import openapi from "../../../shared/openapi/osn.json";
import {
  createOrgClient,
  type OrgClient,
  type OrgMember,
  type OrgSummary,
} from "../src/organisations";

interface Schema {
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

interface Operation {
  parameters?: { in: string; name: string }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}

const spec = openapi as unknown as { paths: Record<string, Record<string, Operation>> };

const TOKEN = "test-token";
const client = createOrgClient({ issuerUrl: "https://osn.example.com" });

afterEach(() => {
  vi.unstubAllGlobals();
});

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");

/**
 * The spec's operation for a request: its path matched a segment at a time, a
 * `{param}` segment standing for any one segment, trailing slashes ignored.
 */
function operationFor(method: string, url: string): Operation | undefined {
  const segments = trimSlashes(new URL(url).pathname).split("/").map(decodeURIComponent);
  for (const [template, operations] of Object.entries(spec.paths)) {
    const parts = trimSlashes(template).split("/");
    if (parts.length !== segments.length) continue;
    if (!parts.every((part, i) => /^\{[^}]+\}$/.test(part) || part === segments[i])) continue;
    const operation = operations[method.toLowerCase()];
    if (operation) return operation;
  }
  return undefined;
}

/** What `run` sent: the first request it made, with a success the client accepts. */
async function sent(run: () => Promise<unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  });
  vi.stubGlobal("fetch", fetchMock);
  await run();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    method: init.method ?? "GET",
    url,
    body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  };
}

/** One call per method; the record's type makes a new method fail until it is listed. */
const CALLS: Record<keyof OrgClient, () => Promise<unknown>> = {
  listMyOrgs: () => client.listMyOrgs(TOKEN, { limit: 5, offset: 0 }),
  getOrg: () => client.getOrg(TOKEN, "acme"),
  createOrg: () => client.createOrg(TOKEN, { handle: "acme", name: "Acme", description: "d" }),
  updateOrg: () => client.updateOrg(TOKEN, "acme", { name: "Acme", description: "d" }),
  deleteOrg: () => client.deleteOrg(TOKEN, "acme"),
  listMembers: () => client.listMembers(TOKEN, "acme", { limit: 5, offset: 10 }),
  addMember: () => client.addMember(TOKEN, "acme", "alice", "member"),
  removeMember: () => client.removeMember(TOKEN, "acme", "alice"),
  updateMemberRole: () => client.updateMemberRole(TOKEN, "acme", "alice", "admin"),
};

/** The JSON schema a route answers with on success. */
function successBody(method: string, template: string): Schema {
  const operation = spec.paths[template]?.[method];
  const response = operation?.responses["200"] ?? operation?.responses["201"];
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`no success body for ${method} ${template}`);
  return schema;
}

// Sets, so the comparison ignores order.
const fieldsOf = (schema: Schema | undefined) => new Set(Object.keys(schema?.properties ?? {}));
const keysOf = (record: Record<string, true>) => new Set(Object.keys(record));

const ORG_SUMMARY: Record<keyof OrgSummary, true> = {
  handle: true,
  name: true,
  description: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
};

const ORG_MEMBER: Record<keyof OrgMember, true> = {
  handle: true,
  displayName: true,
  role: true,
  joinedAt: true,
};

type Body<K extends keyof OrgClient> = Awaited<ReturnType<OrgClient[K]>>;

const LIST_MY_ORGS: Record<keyof Body<"listMyOrgs">, true> = { organisations: true };
const GET_ORG: Record<keyof Body<"getOrg">, true> = { organisation: true };
const CREATE_ORG: Record<keyof Body<"createOrg">, true> = { ok: true, organisation: true };
const UPDATE_ORG: Record<keyof Body<"updateOrg">, true> = { ok: true, organisation: true };
const LIST_MEMBERS: Record<keyof Body<"listMembers">, true> = { members: true };

describe("organisations client against shared/openapi/osn.json", () => {
  it.each(Object.entries(CALLS))("%s calls a route the spec has", async (_name, run) => {
    const request = await sent(run);
    const operation = operationFor(request.method, request.url);
    expect(operation, `${request.method} ${new URL(request.url).pathname}`).toBeDefined();
    const accepted = new Set(
      (operation?.parameters ?? [])
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name),
    );
    expect(
      [...new URL(request.url).searchParams.keys()].filter((key) => !accepted.has(key)),
      "query keys the route does not accept",
    ).toEqual([]);
  });

  it.each(
    (["createOrg", "updateOrg", "addMember", "updateMemberRole"] as const).map(
      (name) => [name, CALLS[name]] as const,
    ),
  )("%s sends a body its route accepts", async (_name, run) => {
    const request = await sent(run);
    const schema = operationFor(request.method, request.url)?.requestBody?.content[
      "application/json"
    ]?.schema;
    expect(schema, "request body schema").toBeDefined();
    const accepted = Object.keys(schema?.properties ?? {});
    const keys = Object.keys(request.body ?? {});
    expect(
      keys.filter((key) => !accepted.includes(key)),
      "keys the route does not accept",
    ).toEqual([]);
    expect(
      (schema?.required ?? []).filter((key) => !keys.includes(key)),
      "required keys left out",
    ).toEqual([]);
  });

  it("OrgSummary names the fields every organisation route answers with", () => {
    const expected = keysOf(ORG_SUMMARY);
    expect(
      fieldsOf(successBody("get", "/organisations/").properties?.organisations?.items),
    ).toEqual(expected);
    expect(
      fieldsOf(successBody("get", "/organisations/{handle}").properties?.organisation),
    ).toEqual(expected);
    expect(fieldsOf(successBody("post", "/organisations/").properties?.organisation)).toEqual(
      expected,
    );
    expect(
      fieldsOf(successBody("patch", "/organisations/{handle}").properties?.organisation),
    ).toEqual(expected);
  });

  it("OrgMember names the fields of a roster row", () => {
    expect(
      fieldsOf(successBody("get", "/organisations/{handle}/members").properties?.members?.items),
    ).toEqual(keysOf(ORG_MEMBER));
  });

  it("each read and write declares the body its route answers with", () => {
    expect(fieldsOf(successBody("get", "/organisations/"))).toEqual(keysOf(LIST_MY_ORGS));
    expect(fieldsOf(successBody("get", "/organisations/{handle}"))).toEqual(keysOf(GET_ORG));
    expect(fieldsOf(successBody("post", "/organisations/"))).toEqual(keysOf(CREATE_ORG));
    expect(fieldsOf(successBody("patch", "/organisations/{handle}"))).toEqual(keysOf(UPDATE_ORG));
    expect(fieldsOf(successBody("get", "/organisations/{handle}/members"))).toEqual(
      keysOf(LIST_MEMBERS),
    );
  });
});
