import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber, Logger, References, Result } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeResendEmailLive } from "../src/resend";
import { EmailService, type SendEmailInput } from "../src/service";

/**
 * What the Resend transport logs when a send fails.
 *
 * On a deployed Worker the email metrics export nothing, and the callers either
 * swallow the failure (every detached notice) or log only an error tag, so this
 * line is the one record of why mail did not go. It must say enough to act on —
 * the HTTP status, Resend's error code, a fixed reading of Resend's message —
 * and must never carry the recipient, the message text, the request body or the
 * key, whatever logger the caller runs it under.
 */

const KEY = "re_test_SuperSecretApiKey_123";
const RECIPIENT = "alice@private-domain.example";

interface Entry {
  readonly level: string;
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
}

let responder: () => Response | Promise<Response>;

beforeEach(() => {
  responder = () => new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responder()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture() {
  const entries: Entry[] = [];
  const layer = Logger.layer([
    Logger.make(({ message, logLevel, fiber }) => {
      entries.push({
        level: logLevel,
        message: Array.isArray(message) ? message.join(" ") : String(message),
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    }),
  ]);
  return { entries, layer };
}

const otp: SendEmailInput = {
  template: "otp-registration",
  to: RECIPIENT,
  data: { code: "424242", ttlMinutes: 10, instanceName: "Musubi" },
};

const transport = () => makeResendEmailLive({ apiKey: KEY, fromAddress: "hello@example.test" });

async function sendOnce(
  wrap: <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.Effect<A, unknown, R> = (eff) => eff,
) {
  const { entries, layer } = capture();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const email = yield* EmailService;
      return yield* wrap(email.send(otp));
    }).pipe(Effect.provide(transport()), Effect.provide(layer), Effect.result),
  );
  return { entries, result };
}

const failures = (entries: readonly Entry[]) =>
  entries.filter((e) => e.message === "email.dispatch_failed");

const resendError = (status: number, name: unknown, message: string) =>
  new Response(JSON.stringify({ statusCode: status, name, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Resend transport: a failed send is logged", () => {
  it("logs an unreachable API with its reason and nothing of the rejection's text", async () => {
    responder = () => {
      throw new TypeError("connect ECONNREFUSED 10.9.8.7:443 secret-upstream.internal");
    };
    const { entries, result } = await sendOnce();

    expect(Result.isFailure(result)).toBe(true);
    const logged = failures(entries);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe("Error");
    expect(logged[0]!.annotations).toEqual({
      template: "otp-registration",
      reason: "api_unreachable",
    });
    expect(JSON.stringify(entries)).not.toContain("secret-upstream");
  });

  it("logs a template that fails to render, in a send or a batch, before anything is sent", async () => {
    const { entries, layer } = capture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        return yield* Effect.result(
          email.send({
            ...otp,
            data: { code: null as unknown as string, ttlMinutes: 10, instanceName: "Musubi" },
          }),
        );
      }).pipe(Effect.provide(transport()), Effect.provide(layer)),
    );
    expect(failures(entries).map((e) => e.annotations)).toEqual([
      { template: "otp-registration", reason: "render_failed" },
    ]);

    const batch = capture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        if (!email.sendBatch) throw new Error("the Resend transport has no sendBatch");
        return yield* Effect.result(
          email.sendBatch([
            otp,
            {
              ...otp,
              data: { code: null as unknown as string, ttlMinutes: 10, instanceName: "Musubi" },
            },
          ]),
        );
      }).pipe(Effect.provide(transport()), Effect.provide(batch.layer)),
    );
    expect(failures(batch.entries).map((e) => e.annotations)).toEqual([
      { template: "otp-registration", reason: "render_failed", size: 2 },
    ]);
  });

  it("logs a 429 with its status and Resend's error code, so a used-up quota reads differently from a burst", async () => {
    responder = () =>
      resendError(429, "daily_quota_exceeded", "You have exceeded your daily email sending quota.");
    const { entries } = await sendOnce();

    expect(failures(entries).map((e) => e.annotations)).toEqual([
      {
        template: "otp-registration",
        reason: "rate_limited",
        status: 429,
        resendError: "daily_quota_exceeded",
      },
    ]);
  });

  it("logs the status of a refusal whose body is not JSON, and still fails with dispatch_failed", async () => {
    responder = () => new Response("<html>upstream error</html>", { status: 500 });
    const { entries, result } = await sendOnce();

    expect(Result.isFailure(result) && result.failure).toMatchObject({ reason: "dispatch_failed" });
    expect(failures(entries).map((e) => e.annotations)).toEqual([
      { template: "otp-registration", reason: "dispatch_failed", status: 500 },
    ]);
  });

  it("drops an error code that could carry anything but a plain code, and lower-cases a mixed-case one", async () => {
    responder = () => resendError(400, `bad ${RECIPIENT}`, "Invalid `to` field.");
    const odd = await sendOnce();
    expect(failures(odd.entries)[0]!.annotations).not.toHaveProperty("resendError");
    expect(JSON.stringify(odd.entries)).not.toContain(RECIPIENT);

    responder = () => resendError(401, "Invalid_API_Key", "API key is invalid");
    const mixed = await sendOnce();
    expect(failures(mixed.entries)[0]!.annotations).toMatchObject({
      status: 401,
      resendError: "invalid_api_key",
    });
  });

  it("reads Resend's 403 message into a fixed code and never logs the message, which names an address", async () => {
    responder = () =>
      resendError(
        403,
        "validation_error",
        `You can only send testing emails to your own email address (${RECIPIENT}). To send emails to other recipients, please verify a domain.`,
      );
    const testing = await sendOnce();
    expect(failures(testing.entries)[0]!.annotations).toEqual({
      template: "otp-registration",
      reason: "dispatch_failed",
      status: 403,
      resendError: "validation_error",
      resendDetail: "testing_recipients_only",
    });
    expect(JSON.stringify(testing.entries)).not.toContain(RECIPIENT);
    expect(JSON.stringify(testing.entries)).not.toContain(KEY);

    responder = () =>
      resendError(
        403,
        "validation_error",
        "The musubi.social domain is not verified. Please, add and verify your domain.",
      );
    const unverified = await sendOnce();
    expect(failures(unverified.entries)[0]!.annotations).toMatchObject({
      resendDetail: "domain_not_verified",
    });
  });

  it("logs a send a caller's timeout cut off, with the status once the response had arrived", async () => {
    responder = () => new Promise<Response>(() => {});
    const hung = await sendOnce((eff) => eff.pipe(Effect.timeout("50 millis")));
    expect(hung.entries.filter((e) => e.message === "email.dispatch_interrupted")).toEqual([
      {
        level: "Warn",
        message: "email.dispatch_interrupted",
        annotations: { template: "otp-registration" },
      },
    ]);

    // The refusal arrives, then its body never finishes: the caller's timeout
    // lands during the body read, and the status is already known.
    responder = () => new Response(new ReadableStream({ start() {} }), { status: 403 });
    const stalled = await sendOnce((eff) => eff.pipe(Effect.timeout("100 millis")));
    expect(stalled.entries.filter((e) => e.message === "email.dispatch_interrupted")).toEqual([
      {
        level: "Warn",
        message: "email.dispatch_interrupted",
        annotations: { template: "otp-registration", status: 403 },
      },
    ]);
  });

  it("logs a refused batch with its template, size and status, and no recipient from it", async () => {
    responder = () =>
      resendError(403, "validation_error", "The example.test domain is not verified.");
    const { entries, layer } = capture();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        if (!email.sendBatch) throw new Error("the Resend transport has no sendBatch");
        return yield* Effect.result(
          email.sendBatch([
            { ...otp, to: "first@private-domain.example" },
            { ...otp, to: "second@private-domain.example" },
          ]),
        );
      }).pipe(Effect.provide(transport()), Effect.provide(layer)),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(failures(entries).map((e) => e.annotations)).toEqual([
      {
        template: "otp-registration",
        reason: "dispatch_failed",
        status: 403,
        size: 2,
        resendError: "validation_error",
        resendDetail: "domain_not_verified",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("private-domain.example");
  });

  it.each([
    {
      label: "a 429",
      respond: () => resendError(429, "rate_limit_exceeded", "Too many requests."),
      logged: {
        template: "otp-registration",
        reason: "rate_limited",
        status: 429,
        size: 2,
        resendError: "rate_limit_exceeded",
      },
    },
    {
      label: "an unreachable API",
      respond: (): Response => {
        throw new TypeError("connect ECONNREFUSED 10.9.8.7:443");
      },
      logged: { template: "otp-registration", reason: "api_unreachable", size: 2 },
    },
  ])(
    "logs a batch that failed with $label, with its size and no recipient",
    async ({ respond, logged }) => {
      responder = respond;
      const { entries, layer } = capture();
      await Effect.runPromise(
        Effect.gen(function* () {
          const email = yield* EmailService;
          if (!email.sendBatch) throw new Error("the Resend transport has no sendBatch");
          return yield* Effect.result(
            email.sendBatch([
              { ...otp, to: "first@private-domain.example" },
              { ...otp, to: "second@private-domain.example" },
            ]),
          );
        }).pipe(Effect.provide(transport()), Effect.provide(layer)),
      );

      expect(failures(entries).map((e) => e.annotations)).toEqual([logged]);
      expect(JSON.stringify(entries)).not.toContain("private-domain.example");
    },
  );

  // An error body of exactly `length` bytes, in Resend's shape, naming the code.
  const errorBodyOf = (length: number): string => {
    const shell = JSON.stringify({ statusCode: 400, name: "validation_error", message: "" });
    return JSON.stringify({
      statusCode: 400,
      name: "validation_error",
      message: "x".repeat(length - shell.length),
    });
  };

  // A body with no declared length, so only the 4096-byte cut decides.
  const streamOf = (text: string, read: { pulled: boolean }) =>
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read.pulled = true;
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

  it("reads 4096 bytes of an error body and no more", async () => {
    const refused = { template: "otp-registration", reason: "dispatch_failed", status: 400 };
    for (const [length, logged] of [
      [4096, { ...refused, resendError: "validation_error" }],
      [4097, refused],
    ] as const) {
      const body = errorBodyOf(length);
      expect(body.length).toBe(length);
      responder = () => new Response(streamOf(body, { pulled: false }), { status: 400 });
      const { entries } = await sendOnce();
      expect(failures(entries)[0]!.annotations).toEqual(logged);
    }
  });

  it("stops reading an error body with no declared length at 4096 bytes and lets the rest go", async () => {
    const read = { pulls: 0, cancelled: false };
    responder = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              read.pulls += 1;
              controller.enqueue(new Uint8Array(1024).fill(0x78));
              // 64 KiB in all, so a reader that never stops still finishes.
              if (read.pulls === 64) controller.close();
            },
            cancel() {
              read.cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 400 },
      );
    const { entries } = await sendOnce();
    expect(read.cancelled).toBe(true);
    expect(read.pulls).toBeLessThanOrEqual(5);
    expect(failures(entries)[0]!.annotations).toEqual({
      template: "otp-registration",
      reason: "dispatch_failed",
      status: 400,
    });
  });

  it("aborts the request to Resend when a caller's timeout cuts a send or a batch off", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>(() => {});
      }),
    );
    await sendOnce((eff) => eff.pipe(Effect.timeout("50 millis")));
    expect(signals.at(-1)?.aborted).toBe(true);

    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        if (!email.sendBatch) throw new Error("the Resend transport has no sendBatch");
        return yield* Effect.result(email.sendBatch([otp]).pipe(Effect.timeout("50 millis")));
      }).pipe(Effect.provide(transport())),
    );
    expect(signals).toHaveLength(2);
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("does not read an error body that declares more than 4096 bytes", async () => {
    const read = { pulled: false };
    responder = () =>
      new Response(streamOf(errorBodyOf(200), read), {
        status: 400,
        headers: { "content-length": "4097" },
      });
    const { entries } = await sendOnce();
    expect(read.pulled).toBe(false);
    expect(failures(entries)[0]!.annotations).toEqual({
      template: "otp-registration",
      reason: "dispatch_failed",
      status: 400,
    });
  });
});

describe("Resend transport: reading a refusal's body", () => {
  effectIt.effect(
    "gives up on a body that never finishes after two seconds, and still fails and logs the status",
    () => {
      const read = { cancelled: false };
      responder = () =>
        new Response(
          new ReadableStream({
            start() {},
            cancel() {
              read.cancelled = true;
            },
          }),
          { status: 403 },
        );
      const { entries, layer } = capture();
      return Effect.gen(function* () {
        const email = yield* EmailService;
        const sending = yield* Effect.forkChild(Effect.result(email.send(otp)));
        // Let the body read's timer reach the test clock before moving it.
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

        yield* TestClock.adjust("1900 millis");
        expect(sending.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("100 millis");
        const result = yield* Fiber.join(sending);
        expect(Result.isFailure(result) && result.failure).toMatchObject({
          reason: "dispatch_failed",
        });
        expect(failures(entries).map((e) => e.annotations)).toEqual([
          { template: "otp-registration", reason: "dispatch_failed", status: 403 },
        ]);
        expect(read.cancelled).toBe(true);
      }).pipe(Effect.provide(transport()), Effect.provide(layer));
    },
  );
});
