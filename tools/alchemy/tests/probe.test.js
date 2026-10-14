import { describe, expect, test } from "bun:test";

import probe from "../probe.ts";

function database(row, queries) {
  return {
    prepare(query) {
      queries.push(query);
      return {
        async first() {
          return row;
        },
      };
    },
  };
}

function bucket(limits) {
  return {
    async list({ limit }) {
      limits.push(limit);
      return { objects: [] };
    },
  };
}

const token = "test-probe-token";
const healthRequest = () =>
  new Request("https://probe.example/health", { headers: { authorization: `Bearer ${token}` } });

describe("Alchemy dev probe", () => {
  test("only GET /health is exposed", async () => {
    const post = await probe.fetch(
      new Request("https://probe.example/health", { method: "POST" }),
      {},
    );
    const other = await probe.fetch(new Request("https://probe.example/other"), {});
    expect(post.status).toBe(404);
    expect(other.status).toBe(404);
  });

  test("unauthorized callers do not read D1", async () => {
    const queries = [];
    const response = await probe.fetch(new Request("https://probe.example/health"), {
      PROBE_PRODUCT: "osn",
      PROBE_TOKEN: token,
      DB: database({ ok: 1 }, queries),
      RL_AUTH_IP_5_60: {},
    });
    expect(response.status).toBe(401);
    expect(queries).toEqual([]);
  });

  test("Cire reads D1 and at most one object from each bucket", async () => {
    const queries = [];
    const limits = [];
    const response = await probe.fetch(healthRequest(), {
      PROBE_PRODUCT: "cire",
      PROBE_TOKEN: token,
      DB: database({ ok: 1 }, queries),
      SHEETS: bucket(limits),
      ASSETS: bucket(limits),
      IMAGES: {},
      CLAIM_RATE_LIMITER: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: "cire", ok: true });
    expect(queries).toEqual(["SELECT 1 AS ok"]);
    expect(limits).toEqual([1, 1]);
  });

  test("a failed D1 read or missing binding fails health", async () => {
    const queries = [];
    const failedDb = await probe.fetch(healthRequest(), {
      PROBE_PRODUCT: "osn",
      PROBE_TOKEN: token,
      DB: database(null, queries),
      RL_AUTH_IP_5_60: {},
    });
    const missingBinding = await probe.fetch(healthRequest(), {
      PROBE_PRODUCT: "osn",
      PROBE_TOKEN: token,
      DB: database({ ok: 1 }, queries),
    });
    expect(failedDb.status).toBe(503);
    expect(missingBinding.status).toBe(503);
  });

  test("OSN returns health when D1 and the limiter are bound", async () => {
    const response = await probe.fetch(healthRequest(), {
      PROBE_PRODUCT: "osn",
      PROBE_TOKEN: token,
      DB: database({ ok: 1 }, []),
      RL_AUTH_IP_5_60: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: "osn", ok: true });
  });
});
