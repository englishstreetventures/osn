import { Db } from "@osn/db/service";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, it, expect, beforeAll } from "vitest";

import { createAccountExportRoutes } from "../../src/routes/account-export";
import { exportLines, type ExportDownstream } from "../../src/services/account-export";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

// The step-up token only signs (no Db), so it can run against the ambient
// runtime. `purpose: account_export` is required by the export verifier.
async function seed(layer: ReturnType<typeof createTestLayer>) {
  const auth = createAuthService(config);
  const profile = await Effect.runPromise(
    auth
      .registerProfile("exporter@example.com", "exporter", "Export Me")
      .pipe(Effect.provide(layer)),
  );
  const tokens = await Effect.runPromise(
    auth
      .issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )
      .pipe(Effect.provide(layer)),
  );
  return { auth, profile, accessToken: tokens.accessToken };
}

const mintStepUp = (auth: ReturnType<typeof createAuthService>, accountId: string) =>
  Effect.runPromise(auth.issueStepUpToken(accountId, "otp", "account_export"));

/** Direct-mode client-IP resolution needs a trusted XFF hop under app.handle. */
const IP_HEADERS = { "x-forwarded-for": "1.2.3.4" };

function makeApp(
  layer: ReturnType<typeof createTestLayer>,
  opts: {
    exportLimiter?: RateLimiterBackend;
    downstreams?: ExportDownstream[];
  } = {},
) {
  return createAccountExportRoutes(
    config,
    layer,
    Layer.empty,
    opts.exportLimiter,
    undefined,
    { trustedProxyCount: 1 },
    undefined,
    opts.downstreams ?? [],
  );
}

describe("GET /account/export — gating", () => {
  it("401 without a bearer token", async () => {
    const app = makeApp(createTestLayer());
    const res = await app.handle(
      new Request("http://localhost/account/export", { headers: IP_HEADERS }),
    );
    expect(res.status).toBe(401);
  });

  it("403 with a bearer token but no step-up token", async () => {
    const layer = createTestLayer();
    const { accessToken } = await seed(layer);
    const app = makeApp(layer);
    const res = await app.handle(
      new Request("http://localhost/account/export", {
        headers: { ...IP_HEADERS, Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
  });

  it("403 when the step-up token has the wrong purpose", async () => {
    const layer = createTestLayer();
    const { auth, profile, accessToken } = await seed(layer);
    // A delete-purpose token must not authorise an export.
    const wrongPurpose = await Effect.runPromise(
      auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
    );
    const app = makeApp(layer);
    const res = await app.handle(
      new Request("http://localhost/account/export", {
        headers: {
          ...IP_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          "x-step-up-token": wrongPurpose,
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a failed step-up (403) does not consume the 1/24h allowance", async () => {
    const layer = createTestLayer();
    const { auth, profile, accessToken } = await seed(layer);
    const app = makeApp(layer); // default 1/24h per-account limiter

    // First attempt: no step-up token → 403, BEFORE the limiter check.
    const denied = await app.handle(
      new Request("http://localhost/account/export", {
        headers: { ...IP_HEADERS, Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(denied.status).toBe(403);

    // A subsequent valid export must still succeed — the allowance is intact.
    const ok = await app.handle(
      new Request("http://localhost/account/export", {
        headers: {
          ...IP_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          "x-step-up-token": await mintStepUp(auth, profile.accountId),
        },
      }),
    );
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("429 on the second export within the window (1/24h per account)", async () => {
    const layer = createTestLayer();
    const { auth, profile, accessToken } = await seed(layer);
    const app = makeApp(layer); // default 1/24h per-account limiter
    const first = await app.handle(
      new Request("http://localhost/account/export", {
        headers: {
          ...IP_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          "x-step-up-token": await mintStepUp(auth, profile.accountId),
        },
      }),
    );
    expect(first.status).toBe(200);
    await first.text(); // drain

    const second = await app.handle(
      new Request("http://localhost/account/export", {
        headers: {
          ...IP_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          "x-step-up-token": await mintStepUp(auth, profile.accountId),
        },
      }),
    );
    expect(second.status).toBe(429);
  });
});

describe("GET /account/export — bundle", () => {
  it("streams a well-formed NDJSON envelope and never leaks the accountId", async () => {
    const layer = createTestLayer();
    const { auth, profile, accessToken } = await seed(layer);
    const app = makeApp(layer);
    const res = await app.handle(
      new Request("http://localhost/account/export", {
        headers: {
          ...IP_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          "x-step-up-token": await mintStepUp(auth, profile.accountId),
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    // P6 privacy invariant — the internal accountId must never appear.
    expect(text).not.toContain(profile.accountId);

    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Header first, terminator last.
    expect(lines[0]).toMatchObject({ version: 1 });
    expect(Array.isArray(lines[0]!.sections)).toBe(true);
    expect(lines[lines.length - 1]).toEqual({ end: true });

    const bySection = (name: string) =>
      lines.filter((l) => l.section === name).map((l) => l.record as Record<string, unknown>);

    // account singleton — explicit fields, no id.
    const account = bySection("account");
    expect(account).toHaveLength(1);
    expect(account[0]).toMatchObject({ email: "exporter@example.com" });
    expect(account[0]).not.toHaveProperty("id");
    expect(account[0]).not.toHaveProperty("accountId");

    // profiles + the session issued during seeding.
    expect(bySection("profiles").some((p) => p.handle === "exporter")).toBe(true);
    expect(bySection("sessions").length).toBeGreaterThanOrEqual(1);

    // recovery_codes is a counts-only singleton.
    const recovery = bySection("recovery_codes");
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ total: expect.any(Number), used: expect.any(Number) });
  });

  it("emits a degraded line when a downstream bridge fails", async () => {
    const layer = createTestLayer();
    const { auth, profile, accessToken } = await seed(layer);
    // A downstream whose fetch always throws → degraded, not a broken stream.
    const app = createAccountExportRoutes(
      config,
      layer,
      Layer.empty,
      undefined,
      undefined,
      { trustedProxyCount: 1 },
      undefined,
      [
        {
          namespace: "pulse",
          url: "http://127.0.0.1:0/internal/account-export",
          audience: "pulse-api",
        },
      ],
    );
    const res = await app.handle(
      new Request("http://localhost/account/export", {
        headers: {
          ...IP_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          "x-step-up-token": await mintStepUp(auth, profile.accountId),
        },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.degraded === "pulse")).toBe(true);
    expect(lines[lines.length - 1]).toEqual({ end: true });
  });

  it("degrades (does not pipe the body) when a downstream returns a non-2xx status", async () => {
    const layer = createTestLayer();
    const runtime = ManagedRuntime.make(layer);
    const auth = createAuthService(config);
    const profile = await runtime.runPromise(
      auth.registerProfile("nak@example.com", "nak").pipe(Effect.provide(layer)),
    );
    const { db } = await runtime.runPromise(Db);

    // A reachable downstream that answers 500 with a body — its lines must NOT
    // leak into the bundle as records; the section must degrade instead.
    const failingFetch = async (): Promise<Response> =>
      new Response('{"section":"pulse.rsvps","record":{"leaked":true}}\n', { status: 500 });

    let out = "";
    for await (const line of exportLines({
      db,
      accountId: profile.accountId,
      downstreams: [
        { namespace: "pulse", url: "http://stub/internal/account-export", audience: "pulse-api" },
      ],
      fetchStream: failingFetch,
    })) {
      out += line;
    }
    expect(out).not.toContain("leaked");
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      lines.some((l) => l.degraded === "pulse" && String(l.reason).startsWith("http_500")),
    ).toBe(true);
    expect(lines[lines.length - 1]).toEqual({ end: true });
    await runtime.dispose();
  });

  it("pipes a downstream NDJSON sub-bundle through the outer envelope", async () => {
    const layer = createTestLayer();
    const runtime = ManagedRuntime.make(layer);
    const auth = createAuthService(config);
    const profile = await runtime.runPromise(
      auth.registerProfile("piped@example.com", "piped").pipe(Effect.provide(layer)),
    );
    const { db } = await runtime.runPromise(Db);

    // Stub a downstream returning two NDJSON lines across two chunks — exercises
    // the line-splitting / chunk-boundary handling in fanOutSection.
    const stubFetch = async (): Promise<Response> => {
      const chunks = [
        `{"section":"pulse.rsvps","record":{"eventId":"evt_1","status":"going"}}\n{"sec`,
        `tion":"pulse.events_hosted","record":{"id":"evt_2"}}\n`,
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
      return new Response(stream);
    };

    const downstreams: ExportDownstream[] = [
      { namespace: "pulse", url: "http://stub/internal/account-export", audience: "pulse-api" },
    ];
    let out = "";
    for await (const line of exportLines({
      db,
      accountId: profile.accountId,
      downstreams,
      fetchStream: stubFetch,
    })) {
      out += line;
    }
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.section === "pulse.rsvps")).toBe(true);
    expect(lines.some((l) => l.section === "pulse.events_hosted")).toBe(true);
    expect(lines[lines.length - 1]).toEqual({ end: true });
    await runtime.dispose();
  });
});
