import { Effect, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeResendEmailLive, RESEND_BATCH_LIMIT } from "../src/resend";
import { EmailError, EmailService, type SendEmailInput } from "../src/service";

/**
 * `sendBatch` on the Resend transport: many emails in one `POST /emails/batch`
 * (up to 100 per call), all or nothing. It exists for senders that run inside
 * one Worker invocation with a fixed budget of outbound requests — cire's daily
 * RSVP digest mails up to 100 organisers for the cost of one request.
 */

const KEY = "re_test_SuperSecretApiKey_123";
const BATCH_URL = "https://api.resend.com/emails/batch";

type Call = { url: string; body: unknown; auth: string | null };
let calls: Call[] = [];
let responder: (n: number) => Response;

beforeEach(() => {
  calls = [];
  responder = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: headers.get("authorization"),
      });
      return responder(calls.length);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const digest = (to: string): SendEmailInput => ({
  template: "rsvp-change-digest",
  to,
  data: {
    weddingName: "Ama & Jonah",
    households: 1,
    counts: { reply_new: 1 },
    rsvpUrl: "https://host.example.test/#/w/wed_1/guests/rsvps",
  },
});

const layer = () => makeResendEmailLive({ apiKey: KEY, fromAddress: "hello@example.test" });

const run = (inputs: readonly SendEmailInput[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const email = yield* EmailService;
      if (!email.sendBatch) throw new Error("the Resend transport has no sendBatch");
      return yield* Effect.result(email.sendBatch(inputs));
    }).pipe(Effect.provide(layer())),
  );

describe("ResendEmailLive.sendBatch", () => {
  it("sends every email, rendered, in one call to the batch endpoint", async () => {
    const result = await run([digest("a@example.test"), digest("b@example.test")]);
    expect(Result.isSuccess(result)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BATCH_URL);
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    const body = calls[0]!.body as { from: string; to: string[]; subject: string; text: string }[];
    expect(body.map((m) => m.to)).toEqual([["a@example.test"], ["b@example.test"]]);
    expect(body[0]!.from).toBe("hello@example.test");
    expect(body[0]!.subject).toBe("RSVP changes for Ama & Jonah");
    expect(body[0]!.text).toContain("1 household replied");
  });

  it("carries a template's headers, and none for a template without them", async () => {
    const stopUrl = "https://api.example.test/api/rsvp-digest/stop?t=abc.def";
    const withStop: SendEmailInput = {
      template: "rsvp-change-digest",
      to: "a@example.test",
      data: {
        weddingName: "Ama & Jonah",
        households: 1,
        counts: { reply_new: 1 },
        rsvpUrl: "https://host.example.test/#/w/wed_1/guests/rsvps",
        stopUrl,
      },
    };
    await run([withStop, digest("b@example.test")]);
    const body = calls[0]!.body as { headers?: Record<string, string> }[];
    expect(body[0]!.headers).toEqual({
      "List-Unsubscribe": `<${stopUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(body[1]!.headers).toBeUndefined();
  });

  it("splits past the provider's limit into calls of at most that many", async () => {
    const inputs = Array.from({ length: RESEND_BATCH_LIMIT + 1 }, (_, i) =>
      digest(`${i}@example.test`),
    );
    await run(inputs);
    expect(RESEND_BATCH_LIMIT).toBe(100);
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 1]);
  });

  it("sends to the override's /emails/batch when apiUrl names a local emulator", async () => {
    const local = makeResendEmailLive({ apiKey: KEY, apiUrl: "http://localhost:4008" });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        if (!email.sendBatch) throw new Error("the Resend transport has no sendBatch");
        return yield* Effect.result(email.sendBatch([digest("a@example.test")]));
      }).pipe(Effect.provide(local)),
    );
    expect(Result.isSuccess(result)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:4008/emails/batch"]);
  });

  it("makes no call for no emails", async () => {
    const result = await run([]);
    expect(Result.isSuccess(result)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("fails the whole batch on a non-2xx, as rate_limited on a 429", async () => {
    responder = () => new Response("boom", { status: 500 });
    const failed = await run([digest("a@example.test")]);
    expect(Result.isFailure(failed) && failed.failure.reason).toBe("dispatch_failed");
    responder = () => new Response("slow down", { status: 429 });
    const limited = await run([digest("a@example.test")]);
    expect(Result.isFailure(limited) && limited.failure.reason).toBe("rate_limited");
  });

  it("fails as api_unreachable when the call throws, and never puts the key in the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const result = await run([digest("a@example.test")]);
    const failure = Result.isFailure(result) ? result.failure : null;
    expect(failure).toBeInstanceOf(EmailError);
    expect(failure?.reason).toBe("api_unreachable");
    expect(JSON.stringify(failure)).not.toContain(KEY);
  });

  it("fails as render_failed before calling out when one email cannot render", async () => {
    const broken = {
      template: "otp-registration",
      to: "c@example.test",
      data: { code: null as unknown as string, ttlMinutes: 10 },
    } satisfies SendEmailInput;
    const result = await run([digest("a@example.test"), broken]);
    expect(Result.isFailure(result) && result.failure.reason).toBe("render_failed");
    expect(calls).toEqual([]);
  });
});
