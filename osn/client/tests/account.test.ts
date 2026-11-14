import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createAccountClient, AccountError } from "../src/account";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createAccountClient", () => {
  const client = createAccountClient({ issuerUrl: "https://osn.example.com", authFetch });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expectAllThroughAuthFetch(authFetch, "include");
    vi.unstubAllGlobals();
  });

  const REQUEST = {
    requestId: "emailchange_0123456789ab",
    claimSecret: "c".repeat(64),
    pairingCode: "42",
    expiresAt: 1_900_000_000,
  };

  it("changeEmailBegin POSTs the new email through authFetch and returns the request", async () => {
    fetchMock.mockResolvedValue(ok(REQUEST));
    const result = await client.changeEmailBegin({
      newEmail: "next@example.com",
    });
    expect(result).toEqual(REQUEST);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/email/begin");
    expect(JSON.parse(init!.body as string)).toEqual({ new_email: "next@example.com" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("changeEmailStatus reads a refusal as expired and a transient as a throw", async () => {
    const poll = () =>
      client.changeEmailStatus({
        requestId: REQUEST.requestId,
        claimSecret: REQUEST.claimSecret,
      });
    fetchMock.mockResolvedValueOnce(ok({ status: "confirmed" }));
    expect(await poll()).toEqual({ status: "confirmed" });
    fetchMock.mockResolvedValueOnce(ok({ status: "pending", pairingCode: "42" }));
    expect(await poll()).toEqual({ status: "pending", pairingCode: "42" });
    for (const status of [400, 401, 404, 422]) {
      fetchMock.mockResolvedValueOnce(ok({ error: "x" }, status));
      expect(await poll()).toEqual({ status: "expired" });
    }
    for (const status of [429, 500]) {
      fetchMock.mockResolvedValueOnce(ok({ error: "x" }, status));
      await expect(poll()).rejects.toThrow(AccountError);
    }
  });

  it("changeEmailComplete forwards the request's claim secret + step-up token", async () => {
    fetchMock.mockResolvedValue(ok({ email: "next@example.com" }));
    const result = await client.changeEmailComplete({
      requestId: REQUEST.requestId,
      claimSecret: REQUEST.claimSecret,
      stepUpToken: "eyJtok",
    });
    expect(result.email).toBe("next@example.com");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://osn.example.com/account/email/${REQUEST.requestId}/complete`);
    expect(JSON.parse(init!.body as string)).toEqual({
      claimSecret: REQUEST.claimSecret,
      step_up_token: "eyJtok",
    });
  });

  it("deleteAccount DELETEs /account with the handle, the step-up token and no choices", async () => {
    fetchMock.mockResolvedValue(ok({ scheduled_for: 1_900_000_000, already_pending: false }, 202));
    const result = await client.deleteAccount({ confirmHandle: "alice", stepUpToken: "eyJtok" });
    expect(result).toEqual({ scheduled_for: 1_900_000_000, already_pending: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account");
    expect(init!.method).toBe("DELETE");
    expect(JSON.parse(init!.body as string)).toEqual({
      confirm_handle: "alice",
      step_up_token: "eyJtok",
    });
  });

  it("deleteAccount sends each choice under the route's field names", async () => {
    fetchMock.mockResolvedValue(ok({ scheduled_for: 1_900_000_000, already_pending: false }, 202));
    await client.deleteAccount({
      confirmHandle: "alice",
      stepUpToken: "eyJtok",
      choices: [
        { action: "osn:organisation:org_1", choice: "transfer" },
        { action: "osn:organisation:org_2", choice: "successor", successorProfileId: "usr_9" },
        { action: "osn:organisation:org_3", choice: "delete" },
      ],
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      confirm_handle: "alice",
      step_up_token: "eyJtok",
      choices: [
        { action: "osn:organisation:org_1", choice: "transfer" },
        { action: "osn:organisation:org_2", choice: "successor", successor_profile_id: "usr_9" },
        { action: "osn:organisation:org_3", choice: "delete" },
      ],
    });
  });

  it("deleteAccount's 409 carries the open actions' code", async () => {
    fetchMock.mockResolvedValue(ok({ error: "open_actions", open_actions: [] }, 409));
    await expect(
      client.deleteAccount({ confirmHandle: "alice", stepUpToken: "eyJtok" }),
    ).rejects.toMatchObject({ name: "AccountError", status: 409, code: "open_actions" });
  });

  it("cancelAccountDeletion POSTs /account/restore with the step-up token", async () => {
    fetchMock.mockResolvedValue(ok({ cancelled: true }));
    expect(await client.cancelAccountDeletion({ stepUpToken: "eyJrestore" })).toEqual({
      cancelled: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/restore");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ step_up_token: "eyJrestore" });
  });

  it("cancelAccountDeletion's 403 carries step_up_required", async () => {
    fetchMock.mockResolvedValue(ok({ error: "step_up_required" }, 403));
    await expect(client.cancelAccountDeletion({ stepUpToken: "stale" })).rejects.toMatchObject({
      name: "AccountError",
      status: 403,
      code: "step_up_required",
    });
  });

  it("getAccountDeletionPreview GETs /account/deletion-preview and returns its open actions", async () => {
    const preview = {
      open_actions: [
        {
          id: "osn:organisation:org_1",
          app: "osn",
          kind: "organisation_owned",
          label: "You own Acme (@acme).",
          choices: [
            { choice: "transfer", description: "@bob becomes the owner." },
            { choice: "successor", description: "The member you name becomes the owner." },
            { choice: "delete", description: "The organisation and its memberships are deleted." },
          ],
          default_choice: "transfer",
          erased_on: null,
          link: null,
          organisation: { id: "org_1", handle: "acme", name: "Acme" },
          successor: { profile_id: "usr_2", handle: "bob", display_name: null, role: "admin" },
        },
      ],
    };
    fetchMock.mockResolvedValue(ok(preview));
    expect(await client.getAccountDeletionPreview()).toEqual(preview);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://osn.example.com/account/deletion-preview");
    expect(init!.method).toBe("GET");
    expect(init!.body).toBeUndefined();
  });

  it("getAccountDeletionPreview refuses an answer without open_actions", async () => {
    fetchMock.mockResolvedValue(ok({ actions: [] }));
    await expect(client.getAccountDeletionPreview()).rejects.toMatchObject({
      name: "AccountError",
      status: 200,
    });
  });

  it("surfaces the server error message via AccountError", async () => {
    fetchMock.mockResolvedValue(ok({ error: "step_up_required" }, 403));
    await expect(
      client.changeEmailComplete({
        requestId: REQUEST.requestId,
        claimSecret: REQUEST.claimSecret,
        stepUpToken: "x",
      }),
    ).rejects.toThrow(AccountError);
  });
});
