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
  AccountDeletionRefusedError,
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
      candidates: true,
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
    // A candidate is a member as the successor is.
    expect(fieldsOf(action?.properties?.["candidates"]?.items)).toEqual(keysOf(SUCCESSOR));
  });

  it("exportAccount reaches the route the spec has, the step-up token in its header", async () => {
    const exported = vi.fn().mockResolvedValue(
      new Response('{"end":true}\n', {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="acme-account-export.ndjson"' },
      }),
    );
    vi.stubGlobal("fetch", exported);
    const file = await client.exportAccount({ stepUpToken: "eyJexport" });
    const [url, init] = exported.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/account/export");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("x-step-up-token")).toBe("eyJexport");
    expect(operation("get", "/account/export")).toBeDefined();
    expect(file.fileName).toBe("acme-account-export.ndjson");
    expect(await file.blob.text()).toBe('{"end":true}\n');
  });

  it("sendDataLink reaches the route the spec has and reads its answer", async () => {
    const request = await sent(() => client.sendDataLink(), { sent: true });
    expect({ method: request.method, path: request.path }).toEqual({
      method: "post",
      path: "/account/data-link",
    });
    expect(fieldsOf(responseSchema("post", "/account/data-link", "202"))).toEqual(
      new Set(["sent"]),
    );
  });
});

/**
 * Each refusal that names what to look at again carries it to the caller, so
 * the screen can land the person on it. Red when the body is dropped, which is
 * what a plain `AccountError` does.
 */
describe("deleteAccount refusals carry what to look at again", () => {
  const action = {
    id: "cire:wedding:wed_1",
    app: "cire",
    kind: "wedding_sole_owner",
    label: "You are the only owner.",
    choices: [{ choice: "delete", description: "Deleted.", erased_on: null }],
    default_choice: null,
    link: null,
  };
  const refuse = (status: number, body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  const refusal = async () => {
    try {
      await client.deleteAccount({ confirmHandle: "alice", stepUpToken: "t" });
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  };

  it("open_actions: the actions still waiting", async () => {
    refuse(409, { error: "open_actions", open_actions: [action] });
    const err = await refusal();
    expect(err).toBeInstanceOf(AccountDeletionRefusedError);
    expect((err as AccountDeletionRefusedError).code).toBe("open_actions");
    expect((err as AccountDeletionRefusedError).openActions).toEqual([action]);
  });

  it.each(["stale_choices", "could_not_check"] as const)(
    "%s: the server's fresh preview",
    async (code) => {
      refuse(409, { error: code, open_actions: [action], could_not_check: ["zap"] });
      const err = (await refusal()) as AccountDeletionRefusedError;
      expect(err).toBeInstanceOf(AccountDeletionRefusedError);
      expect(err.preview).toEqual({ open_actions: [action], could_not_check: ["zap"] });
    },
  );

  it("invalid_choice: the action refused", async () => {
    refuse(400, { error: "invalid_choice", action: "osn:organisation:org_1" });
    const err = (await refusal()) as AccountDeletionRefusedError;
    expect(err).toBeInstanceOf(AccountDeletionRefusedError);
    expect(err.action).toBe("osn:organisation:org_1");
  });

  it("any other refusal stays a plain AccountError with its code", async () => {
    refuse(400, { error: "handle_mismatch" });
    const err = (await refusal()) as AccountError;
    expect(err).not.toBeInstanceOf(AccountDeletionRefusedError);
    expect(err.code).toBe("handle_mismatch");
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
