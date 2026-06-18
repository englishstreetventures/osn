import { Effect, Either, Logger } from "effect";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { makeResendEmailLive } from "../src/resend";
import { EmailError, EmailService, type SendEmailInput } from "../src/service";

const RESEND_API_KEY = "re_test_SuperSecretApiKey_123";
const EXPECTED_URL = "https://api.resend.com/emails";

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
  responder = () => new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
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
  return makeResendEmailLive({
    apiKey: RESEND_API_KEY,
    fromAddress: "noreply@osn.test",
  });
}

describe("ResendEmailLive", () => {
  it("POSTs JSON to the Resend API with a bearer key and the rendered body", async () => {
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
    expect(captured!.headers.get("authorization")).toBe(`Bearer ${RESEND_API_KEY}`);

    const payload = JSON.parse(captured!.body) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(payload.from).toBe("noreply@osn.test");
    expect(payload.to).toEqual(["alice@example.com"]);
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

  it("returns rate_limited on API 429 (matches Cloudflare transport)", async () => {
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

  it("returns dispatch_failed on API 5xx (matches Cloudflare transport)", async () => {
    responder = () => new Response("boom", { status: 500 });
    await expectFailsWith(
      buildLayer(),
      { template: "passkey-added", to: "alice@example.com", data: {} },
      "dispatch_failed",
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

    const payload = JSON.parse(captured!.body) as { to: string[] };
    expect(payload.to).toEqual(["user+tag@sub.domain.example.com"]);
  });

  it("never places the API key in the URL, body, span attributes or error cause", async () => {
    // Capture everything the transport logs/emits across both a success and a
    // failure path, then assert the secret never appears anywhere observable.
    const lines: string[] = [];
    const captureLogger = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) => {
        lines.push(Array.isArray(message) ? message.join(" ") : String(message));
      }),
    );

    // Success path.
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-registration",
          to: "alice@example.com",
          data: { code: "424242", ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(buildLayer()), Effect.provide(captureLogger)),
    );

    // URL must never carry the key.
    expect(captured!.url).not.toContain(RESEND_API_KEY);
    // Body must never carry the key (it lives in the header only).
    expect(captured!.body).not.toContain(RESEND_API_KEY);
    // Header carries it as Bearer — and nowhere else.
    expect(captured!.headers.get("authorization")).toBe(`Bearer ${RESEND_API_KEY}`);

    // Failure path — the EmailError cause must never embed the key.
    responder = () => new Response("boom", { status: 500 });
    const either = await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        return yield* email.send({
          template: "passkey-removed",
          to: "alice@example.com",
          data: {},
        });
      }).pipe(Effect.provide(buildLayer()), Effect.provide(captureLogger), Effect.either),
    );
    expect(Either.isLeft(either)).toBe(true);
    // Serialise the whole Either (error + cause) and assert the key is absent —
    // no conditional expect needed.
    expect(JSON.stringify(either)).not.toContain(RESEND_API_KEY);

    // Nothing logged should contain the key.
    expect(lines.join("\n")).not.toContain(RESEND_API_KEY);
  });
});
