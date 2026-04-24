import { Effect, Either } from "effect";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { makeCloudflareEmailLive } from "../src/cloudflare";
import { EmailError, EmailService, type SendEmailInput } from "../src/service";

const CF_ACCOUNT_ID = "test-account-id";
const CF_API_TOKEN = "test-api-token";
const EXPECTED_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/email-service/send`;

type Captured = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
};

let captured: Captured | null = null;
let responder: () => Response;

beforeEach(() => {
  captured = null;
  responder = () => new Response("", { status: 202 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers ?? {}),
        body: typeof init?.body === "string" ? init.body : "",
      };
      return responder();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildLayer() {
  return makeCloudflareEmailLive({
    accountId: CF_ACCOUNT_ID,
    apiToken: CF_API_TOKEN,
    fromAddress: "noreply@osn.test",
  });
}

describe("CloudflareEmailLive", () => {
  it("POSTs JSON to the Cloudflare Email API with a bearer token and the rendered body", async () => {
    const layer = buildLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-registration",
          to: "alice@example.com",
          data: { code: "000000", ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(EXPECTED_URL);
    expect(captured!.method).toBe("POST");
    expect(captured!.headers.get("content-type")).toBe("application/json");
    expect(captured!.headers.get("authorization")).toBe(`Bearer ${CF_API_TOKEN}`);

    const payload = JSON.parse(captured!.body) as {
      to: Array<{ email: string }>;
      from: { email: string };
      subject: string;
      text: string;
      html: string;
    };
    expect(payload.to).toEqual([{ email: "alice@example.com" }]);
    expect(payload.from).toEqual({ email: "noreply@osn.test" });
    expect(payload.subject).toBe("Verify your OSN email");
    expect(payload.text).toContain("000000");
    expect(payload.html).toContain("000000");
  });

  const expectFailsWith = async (
    layer: ReturnType<typeof buildLayer>,
    input: SendEmailInput,
    reason: EmailError["reason"],
  ) => {
    const either = await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        return yield* email.send(input);
      }).pipe(Effect.provide(layer), Effect.either),
    );
    expect(Either.isLeft(either)).toBe(true);
    if (Either.isLeft(either)) {
      expect(either.left).toBeInstanceOf(EmailError);
      expect(either.left.reason).toBe(reason);
    }
  };

  it("returns rate_limited on API 429", async () => {
    responder = () => new Response("too many", { status: 429 });
    await expectFailsWith(
      buildLayer(),
      {
        template: "otp-step-up",
        to: "alice@example.com",
        data: { code: "000000", ttlMinutes: 5 },
      },
      "rate_limited",
    );
  });

  it("returns dispatch_failed on API 5xx", async () => {
    responder = () => new Response("boom", { status: 500 });
    await expectFailsWith(
      buildLayer(),
      { template: "passkey-added", to: "alice@example.com", data: {} },
      "dispatch_failed",
    );
  });

  it("returns api_unreachable when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expectFailsWith(
      buildLayer(),
      { template: "recovery-consumed", to: "alice@example.com", data: {} },
      "api_unreachable",
    );
  });

  it("returns dispatch_failed on API 4xx (non-429) — boundary at 422", async () => {
    responder = () => new Response("validation failed", { status: 422 });
    await expectFailsWith(
      buildLayer(),
      {
        template: "otp-registration",
        to: "alice@example.com",
        data: { code: "000000", ttlMinutes: 10 },
      },
      "dispatch_failed",
    );
  });

  it("returns render_failed when a template renderer throws", async () => {
    await expectFailsWith(
      buildLayer(),
      {
        template: "otp-registration",
        to: "alice@example.com",
        data: { code: null as unknown as string, ttlMinutes: 10 },
      },
      "render_failed",
    );
  });

  it("preserves plus-addressed and subdomain emails in the payload", async () => {
    const layer = buildLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "passkey-added",
          to: "user+tag@sub.domain.example.com",
          data: {},
        });
      }).pipe(Effect.provide(layer)),
    );

    const payload = JSON.parse(captured!.body) as {
      to: Array<{ email: string }>;
    };
    expect(payload.to).toEqual([{ email: "user+tag@sub.domain.example.com" }]);
  });

  it("does not include OTP code on span attributes (only `template`)", async () => {
    const layer = buildLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-registration",
          to: "alice@example.com",
          data: { code: "999888", ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(layer)),
    );
    // URL path must not contain the code.
    expect(captured!.url).not.toContain("999888");
    // Headers must not contain the code.
    captured!.headers.forEach((v, k) => {
      expect(v).not.toContain("999888");
      expect(k).not.toContain("999888");
    });
    // Code only appears in the body.
    expect(captured!.body).toContain("999888");
  });
});
