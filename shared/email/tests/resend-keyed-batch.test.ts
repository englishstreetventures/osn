import { Effect, Logger, References, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeResendEmailLive, RESEND_BATCH_LIMIT } from "../src/resend";
import { EmailError, EmailService, type SendEmailInput } from "../src/service";

/**
 * `sendKeyedBatch` on the Resend transport: one `POST /emails/batch` under an
 * idempotency key, in permissive validation. A sender that must neither skip
 * nor repeat anyone retries a batch whose outcome it did not learn under the
 * same key, and Resend sends nothing twice for one key within 24 hours. So the
 * key must go on the one call, a batch must never be split across calls under
 * it, and the caller must learn the status and Resend's error name of a refusal
 * — a 409 under a key means something different from a 409 without one — and
 * how many addresses Resend refused on their own.
 */

const KEY = "re_test_SuperSecretApiKey_123";
const BATCH_URL = "https://api.resend.com/emails/batch";
const IDEMPOTENCY_KEY = "change-notice/privacy-2027/6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

type Call = { url: string; body: unknown; headers: Headers };
let calls: Call[] = [];
let responder: (n: number) => Response;

beforeEach(() => {
  calls = [];
  responder = () => Response.json({ data: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers ?? {}),
      });
      return responder(calls.length);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const notice = (to: string): SendEmailInput => ({
  template: "change-notice",
  to,
  data: {
    instanceName: "Acme",
    document: "privacy notice",
    changes: ["We now keep sign-in records for 12 months."],
    takesEffect: Date.UTC(2027, 0, 1) / 1_000,
    url: "https://app.example.test/privacy",
  },
});

const ADDRESSES = ["a@example.test", "b@example.test", "c@example.test"];

function capture() {
  const lines: string[] = [];
  const layer = Logger.layer([
    Logger.make(({ message, fiber }) => {
      lines.push(
        JSON.stringify({
          message,
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        }),
      );
    }),
  ]);
  return { lines, layer };
}

const run = (inputs: readonly SendEmailInput[], logger = capture()) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const email = yield* EmailService;
      if (!email.sendKeyedBatch) throw new Error("the Resend transport has no sendKeyedBatch");
      return yield* Effect.result(
        email.sendKeyedBatch(inputs, { idempotencyKey: IDEMPOTENCY_KEY }),
      );
    }).pipe(
      Effect.provide(makeResendEmailLive({ apiKey: KEY, fromAddress: "hello@example.test" })),
      Effect.provide(logger.layer),
    ),
  );

describe("ResendEmailLive.sendKeyedBatch", () => {
  it("sends the batch in one call, under the key, in permissive validation", async () => {
    responder = () => Response.json({ data: ADDRESSES.map((_, i) => ({ id: `id-${i}` })) });
    const result = await run(ADDRESSES.map(notice));
    expect(Result.isSuccess(result) && result.success).toEqual({ accepted: 3, refused: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BATCH_URL);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers.get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    expect(calls[0]!.headers.get("x-batch-validation")).toBe("permissive");
    const body = calls[0]!.body as { to: string[] }[];
    expect(body.map((m) => m.to)).toEqual(ADDRESSES.map((a) => [a]));
  });

  it("refuses more than one call's worth before any request, since one key covers one call", async () => {
    const inputs = Array.from({ length: RESEND_BATCH_LIMIT + 1 }, (_, i) =>
      notice(`${i}@example.test`),
    );
    const result = await run(inputs);
    expect(Result.isFailure(result) && result.failure.reason).toBe("dispatch_failed");
    expect(calls).toEqual([]);
  });

  it("puts the status and Resend's error name on a refusal, and nothing else from the body", async () => {
    responder = () =>
      Response.json(
        {
          statusCode: 409,
          name: "invalid_idempotent_request",
          message: `Same idempotency key used with a different payload for ${ADDRESSES[0]}.`,
        },
        { status: 409 },
      );
    const result = await run(ADDRESSES.map(notice));
    const failure = Result.isFailure(result) ? result.failure : null;
    expect(failure).toBeInstanceOf(EmailError);
    expect(failure?.reason).toBe("dispatch_failed");
    expect(failure?.status).toBe(409);
    expect(failure?.providerError).toBe("invalid_idempotent_request");
    const serialised = JSON.stringify(failure);
    for (const address of ADDRESSES) expect(serialised).not.toContain(address);
    expect(serialised).not.toContain(KEY);
  });

  it("drops an error name outside the code pattern", async () => {
    responder = () =>
      Response.json({ name: "Not A Code <alice@example.test>", message: "x" }, { status: 422 });
    const result = await run(ADDRESSES.map(notice));
    const failure = Result.isFailure(result) ? result.failure : null;
    expect(failure?.status).toBe(422);
    expect(failure?.providerError).toBeUndefined();
  });

  it("keeps the status of a 409 whose body cannot be read, with no error name", async () => {
    responder = () => new Response("<html>conflict</html>", { status: 409 });
    const result = await run(ADDRESSES.map(notice));
    const failure = Result.isFailure(result) ? result.failure : null;
    expect(failure?.status).toBe(409);
    expect(failure?.providerError).toBeUndefined();
  });

  it("fails a 429 as rate_limited with its status", async () => {
    responder = () =>
      Response.json({ name: "daily_quota_exceeded", message: "quota" }, { status: 429 });
    const result = await run(ADDRESSES.map(notice));
    const failure = Result.isFailure(result) ? result.failure : null;
    expect(failure?.reason).toBe("rate_limited");
    expect(failure?.status).toBe(429);
    expect(failure?.providerError).toBe("daily_quota_exceeded");
  });

  it("counts the addresses Resend refused on their own, and never logs their messages", async () => {
    const logger = capture();
    responder = () =>
      Response.json({
        data: [{ id: "id-0" }, { id: "id-2" }],
        errors: [
          { index: 1, message: `Invalid \`to\` field: ${ADDRESSES[1]}` },
          { index: 7, message: "out of range" },
          { index: "1", message: "not a number" },
          { message: "no index" },
        ],
      });
    const result = await run(ADDRESSES.map(notice), logger);
    expect(Result.isSuccess(result) && result.success).toEqual({ accepted: 2, refused: 1 });
    const logged = logger.lines.join("\n");
    for (const address of ADDRESSES) expect(logged).not.toContain(address);
  });

  it("counts every address accepted when a 2xx body cannot be read", async () => {
    responder = () => new Response("ok", { status: 200 });
    const result = await run(ADDRESSES.map(notice));
    expect(Result.isSuccess(result) && result.success).toEqual({ accepted: 3, refused: 0 });
  });
});
