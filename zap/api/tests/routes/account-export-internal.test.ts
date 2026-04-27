import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAccountExportInternalRoutes } from "../../src/routes/accountExportInternal";
import { createTestLayer, seedChat, seedMember, seedMessage } from "../helpers/db";

/**
 * HTTP-level coverage for the Zap internal export endpoint. Mirrors the
 * Pulse counterpart: same auth contract, same NDJSON wire shape. The
 * critical extra invariant is the ciphertext exclusion advisory line
 * — the orchestrator's bridge re-emits this verbatim so the bundle is
 * self-documenting.
 */

const ENV_KEY = "INTERNAL_SERVICE_SECRET";
const SECRET = "test-internal-secret-zap";

let restore: string | undefined;
beforeEach(() => {
  restore = process.env[ENV_KEY];
  process.env[ENV_KEY] = SECRET;
});
afterEach(() => {
  if (restore === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = restore;
});

const parseNdjson = async (res: Response): Promise<Array<Record<string, unknown>>> => {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe("POST /account-export/internal (zap)", () => {
  it("returns 401 on a wrong bearer secret", async () => {
    const app = createAccountExportInternalRoutes(createTestLayer());
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 501 when the secret is unset", async () => {
    delete process.env[ENV_KEY];
    const app = createAccountExportInternalRoutes(createTestLayer());
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [] }),
      }),
    );
    expect(res.status).toBe(501);
  });

  it("emits the ciphertext-excluded advisory + end trailer for an empty account", async () => {
    const app = createAccountExportInternalRoutes(createTestLayer());
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [] }),
      }),
    );
    const lines = await parseNdjson(res);
    expect(lines[0]).toMatchObject({ source: "zap-api" });
    expect(lines[lines.length - 1]).toMatchObject({ end: true });
    const advisory = lines.find(
      (l) => (l as { section?: string }).section === "zap.chats_advisory",
    );
    expect(advisory).toBeDefined();
    expect((advisory as { row: { excluded: string } }).row.excluded).toBe("messages.ciphertext");
  });

  it("never serialises the message ciphertext when chats exist", async () => {
    const layer = createTestLayer();
    const profileId = "usr_alice";
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* seedChat({ type: "dm" });
        yield* seedMember(chat.id, profileId, "admin");
        yield* seedMessage(chat.id, profileId, "ENCRYPTED_PAYLOAD_DO_NOT_LEAK", new Date());
      }).pipe(Effect.provide(layer)),
    );

    const app = createAccountExportInternalRoutes(layer);
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [profileId] }),
      }),
    );
    const text = await res.text();
    expect(text).not.toContain("ENCRYPTED_PAYLOAD_DO_NOT_LEAK");
    // Membership row should still be present.
    expect(text).toContain("zap.chats");
  });
});
