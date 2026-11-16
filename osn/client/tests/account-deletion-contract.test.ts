/**
 * The account client's deletion calls against the API's own description of
 * itself, `shared/openapi/osn.json`, which CI regenerates from the routes and
 * fails on any difference. `deleteAccount`, `cancelAccountDeletion` and
 * `getAccountDeletionPreview` must reach the routes the spec has, send bodies
 * whose field names those routes accept, and declare the fields the routes
 * answer with.
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
  AccountError,
  createAccountClient,
  type AccountClient,
  type AccountDeletionOpenAction,
  type AccountDeletionPreview,
} from "../src/account";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

interface Schema {
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

interface Operation {
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}

const spec = openapi as unknown as { paths: Record<string, Record<string, Operation>> };

const client = createAccountClient({ issuerUrl: "https://osn.example.com", authFetch });

afterEach(() => {
  expectAllThroughAuthFetch(authFetch, "include");
  vi.unstubAllGlobals();
});

/** What `run` sent: the one request it made, answered 200 with `answer`. */
async function sent(run: () => Promise<unknown>, answer: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await run();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    method: (init.method ?? "GET").toLowerCase(),
    path: new URL(url).pathname,
    body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  };
}

/** The spec's operation for `method` on `path`, which must exist. */
function operation(method: string, path: string): Operation {
  const found = spec.paths[path]?.[method];
  if (!found) throw new Error(`no ${method} ${path} in the spec`);
  return found;
}

/** The JSON schema of the body `method` on `path` takes. */
const requestSchema = (method: string, path: string): Schema => {
  const schema = operation(method, path).requestBody?.content["application/json"]?.schema;
  if (!schema) throw new Error(`no request body for ${method} ${path}`);
  return schema;
};

/** The JSON schema of the body `method` on `path` answers `status` with. */
const responseSchema = (method: string, path: string, status: string): Schema => {
  const schema = operation(method, path).responses[status]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`no ${status} body for ${method} ${path}`);
  return schema;
};

// Sets, so the comparison ignores order.
const fieldsOf = (schema: Schema | undefined) => new Set(Object.keys(schema?.properties ?? {}));
const keysOf = (record: Record<string, true>) => new Set(Object.keys(record));

/** Keys of `body` its schema does not name, and required keys `body` leaves out. */
const mismatches = (body: Record<string, unknown>, schema: Schema) => ({
  unknown: Object.keys(body).filter((key) => !fieldsOf(schema).has(key)),
  missing: (schema.required ?? []).filter((key) => !(key in body)),
});

const NO_MISMATCH = { unknown: [], missing: [] };

describe("account deletion client against shared/openapi/osn.json", () => {
  it.each([
    [
      "deleteAccount",
      "delete",
      "/account",
      () => client.deleteAccount({ confirmHandle: "a", stepUpToken: "t" }),
    ],
    [
      "cancelAccountDeletion",
      "post",
      "/account/restore",
      () => client.cancelAccountDeletion({ stepUpToken: "t" }),
    ],
    [
      "getAccountDeletionPreview",
      "get",
      "/account/deletion-preview",
      () => client.getAccountDeletionPreview(),
    ],
  ] as const)("%s calls %s %s, which the spec has", async (_name, method, path, run) => {
    const request = await sent(run, { open_actions: [], could_not_check: [] });
    expect({ method: request.method, path: request.path }).toEqual({ method, path });
    expect(operation(method, path)).toBeDefined();
  });

  it("deleteAccount sends each answer under the field names DELETE /account takes", async () => {
    const request = await sent(() =>
      client.deleteAccount({
        confirmHandle: "alice",
        stepUpToken: "eyJtok",
        choices: [
          { action: "osn:organisation:org_1", choice: "transfer" },
          { action: "osn:organisation:org_2", choice: "successor", successorProfileId: "usr_9" },
          { action: "osn:organisation:org_3", choice: "delete" },
        ],
      }),
    );
    const schema = requestSchema("delete", "/account");

    expect(request.body).toEqual({
      confirm_handle: "alice",
      step_up_token: "eyJtok",
      choices: [
        { action: "osn:organisation:org_1", choice: "transfer" },
        { action: "osn:organisation:org_2", choice: "successor", successor_profile_id: "usr_9" },
        { action: "osn:organisation:org_3", choice: "delete" },
      ],
    });
    expect(mismatches(request.body!, schema)).toEqual(NO_MISMATCH);
    for (const answer of request.body!["choices"] as Record<string, unknown>[]) {
      expect(mismatches(answer, schema.properties!["choices"]!.items!)).toEqual(NO_MISMATCH);
    }
  });

  it("deleteAccount with delete everything sends the flag under the name DELETE /account takes", async () => {
    const request = await sent(() =>
      client.deleteAccount({
        confirmHandle: "alice",
        stepUpToken: "eyJtok",
        deleteEverything: true,
      }),
    );

    expect(request.body).toEqual({
      confirm_handle: "alice",
      step_up_token: "eyJtok",
      delete_everything: true,
    });
    expect(mismatches(request.body!, requestSchema("delete", "/account"))).toEqual(NO_MISMATCH);
  });

  it("deleteAccount with no answers sends no choices, and still a body DELETE /account takes", async () => {
    const request = await sent(() =>
      client.deleteAccount({ confirmHandle: "alice", stepUpToken: "eyJtok" }),
    );

    expect(request.body).toEqual({ confirm_handle: "alice", step_up_token: "eyJtok" });
    expect(mismatches(request.body!, requestSchema("delete", "/account"))).toEqual(NO_MISMATCH);
  });

  it("cancelAccountDeletion sends the step-up token under the name POST /account/restore takes", async () => {
    const request = await sent(() => client.cancelAccountDeletion({ stepUpToken: "eyJrestore" }));

    expect(request.body).toEqual({ step_up_token: "eyJrestore" });
    expect(mismatches(request.body!, requestSchema("post", "/account/restore"))).toEqual(
      NO_MISMATCH,
    );
  });

  it("getAccountDeletionPreview sends no body", async () => {
    const request = await sent(() => client.getAccountDeletionPreview(), {
      open_actions: [],
      could_not_check: [],
    });
    expect(request.body).toBeNull();
  });

  it("getAccountDeletionPreview refuses an answer without the list of apps it could not ask", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ open_actions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(client.getAccountDeletionPreview()).rejects.toBeInstanceOf(AccountError);
  });

  it("the preview types name the fields GET /account/deletion-preview answers with", () => {
    const PREVIEW: Record<keyof AccountDeletionPreview, true> = {
      open_actions: true,
      could_not_check: true,
    };
    const OPEN_ACTION: Record<keyof AccountDeletionOpenAction, true> = {
      id: true,
      app: true,
      kind: true,
      label: true,
      choices: true,
      default_choice: true,
      link: true,
      organisation: true,
      successor: true,
    };
    const CHOICE: Record<keyof AccountDeletionOpenAction["choices"][number], true> = {
      choice: true,
      description: true,
      erased_on: true,
    };
    const ORGANISATION: Record<keyof NonNullable<AccountDeletionOpenAction["organisation"]>, true> =
      {
        id: true,
        handle: true,
        name: true,
      };
    const SUCCESSOR: Record<keyof NonNullable<AccountDeletionOpenAction["successor"]>, true> = {
      profile_id: true,
      handle: true,
      display_name: true,
      role: true,
    };

    const body = responseSchema("get", "/account/deletion-preview", "200");
    const action = body.properties?.["open_actions"]?.items;
    expect(fieldsOf(body)).toEqual(keysOf(PREVIEW));
    expect(fieldsOf(action)).toEqual(keysOf(OPEN_ACTION));
    expect(fieldsOf(action?.properties?.["choices"]?.items)).toEqual(keysOf(CHOICE));
    expect(fieldsOf(action?.properties?.["organisation"])).toEqual(keysOf(ORGANISATION));
    expect(fieldsOf(action?.properties?.["successor"])).toEqual(keysOf(SUCCESSOR));
  });

  it("deleteAccount and cancelAccountDeletion declare the bodies their routes answer with", () => {
    const SCHEDULED: Record<keyof Awaited<ReturnType<AccountClient["deleteAccount"]>>, true> = {
      scheduled_for: true,
      already_pending: true,
    };
    const CANCELLED: Record<
      keyof Awaited<ReturnType<AccountClient["cancelAccountDeletion"]>>,
      true
    > = { cancelled: true };

    expect(fieldsOf(responseSchema("delete", "/account", "202"))).toEqual(keysOf(SCHEDULED));
    expect(fieldsOf(responseSchema("post", "/account/restore", "200"))).toEqual(keysOf(CANCELLED));
  });
});
