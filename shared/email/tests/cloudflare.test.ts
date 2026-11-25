import { Effect, Result } from "effect";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { makeCloudflareEmailLive } from "../src/cloudflare";
import { EmailError, EmailService, type SendEmailInput } from "../src/service";

const CF_ACCOUNT_ID = "test-account-id";
const CF_API_TOKEN = "test-api-token";
const EXPECTED_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/email/sending/send`;

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
          template: "link-email-change",
          to: "alice@example.com",
          data: {
            url: "https://musubi.example/verify#000000",
            ttlMinutes: 10,
            instanceName: "Musubi",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(EXPECTED_URL);
    expect(captured!.method).toBe("POST");
    expect(captured!.headers.get("content-type")).toBe("application/json");
    expect(captured!.headers.get("authorization")).toBe(`Bearer ${CF_API_TOKEN}`);

    const payload = JSON.parse(captured!.body) as {
      to: unknown;
      from: unknown;
      subject: string;
      text: string;
      html: string;
    };
    expect(payload.to).toStrictEqual({ address: "alice@example.com" });
    expect(payload.from).toStrictEqual({ address: "noreply@osn.test" });
    expect(payload.subject).toBe("Confirm your new Musubi email");
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
      }).pipe(Effect.provide(layer), Effect.result),
    );
    expect(Result.isFailure(either)).toBe(true);
    if (Result.isFailure(either)) {
      expect(either.failure).toBeInstanceOf(EmailError);
      expect(either.failure.reason).toBe(reason);
    }
  };

  it("returns rate_limited on API 429", async () => {
    responder = () => new Response("too many", { status: 429 });
    await expectFailsWith(
      buildLayer(),
      {
        template: "link-email-change",
        to: "alice@example.com",
        data: {
          url: "https://musubi.example/verify#000000",
          ttlMinutes: 5,
          instanceName: "Musubi",
        },
      },
      "rate_limited",
    );
  });

  it("returns dispatch_failed on API 5xx", async () => {
    responder = () => new Response("boom", { status: 500 });
    await expectFailsWith(
      buildLayer(),
      { template: "passkey-added", to: "alice@example.com", data: { instanceName: "Musubi" } },
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
      { template: "recovery-consumed", to: "alice@example.com", data: { instanceName: "Musubi" } },
      "api_unreachable",
    );
  });

  it("returns dispatch_failed on API 4xx (non-429) — boundary at 422", async () => {
    responder = () => new Response("validation failed", { status: 422 });
    await expectFailsWith(
      buildLayer(),
      {
        template: "link-email-change",
        to: "alice@example.com",
        data: {
          url: "https://musubi.example/verify#000000",
          ttlMinutes: 10,
          instanceName: "Musubi",
        },
      },
      "dispatch_failed",
    );
  });

  it("returns render_failed when a template renderer throws", async () => {
    await expectFailsWith(
      buildLayer(),
      {
        template: "link-email-change",
        to: "alice@example.com",
        data: { url: null as unknown as string, ttlMinutes: 10, instanceName: "Musubi" },
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
          data: { instanceName: "Musubi" },
        });
      }).pipe(Effect.provide(layer)),
    );

    const payload = JSON.parse(captured!.body) as { to: unknown };
    expect(payload.to).toStrictEqual({ address: "user+tag@sub.domain.example.com" });
  });

  it("does not include OTP code on span attributes (only `template`)", async () => {
    const layer = buildLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "link-email-change",
          to: "alice@example.com",
          data: {
            url: "https://musubi.example/verify#999888",
            ttlMinutes: 10,
            instanceName: "Musubi",
          },
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

describe("CloudflareEmailLive sender", () => {
  const EMPTY = "Cloudflare email sender is empty";
  const UNSAFE = "Cloudflare email sender contains a control, format or line-separator character";
  const NOT_A_SENDER =
    "Cloudflare email sender must be an address, or a display name followed by an address in angle brackets";
  const LENGTH =
    "Cloudflare email sender has an address longer than 254 characters or a local part longer than 64";

  /** The longest address the limits allow: a 64-character local part, 254 in all. */
  const LONGEST = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;

  /** Builds the transport with `fromAddress`, sends one email and returns the payload's `from`. */
  const sentFrom = async (fromAddress?: string): Promise<unknown> => {
    const layer = makeCloudflareEmailLive({
      accountId: CF_ACCOUNT_ID,
      apiToken: CF_API_TOKEN,
      ...(fromAddress === undefined ? {} : { fromAddress }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "passkey-added",
          to: "alice@example.com",
          data: { instanceName: "Musubi" },
        });
      }).pipe(Effect.provide(layer)),
    );
    return (JSON.parse(captured!.body) as { from: unknown }).from;
  };

  /** The message `makeCloudflareEmailLive` throws for `fromAddress`, or null when it builds. */
  const refusal = (fromAddress: string): string | null => {
    try {
      makeCloudflareEmailLive({ accountId: CF_ACCOUNT_ID, apiToken: CF_API_TOKEN, fromAddress });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it.each([
    ["Musubi <hello@musubi.social>", { address: "hello@musubi.social", name: "Musubi" }],
    ["Musubi (dev) <dev@musubi.social>", { address: "dev@musubi.social", name: "Musubi (dev)" }],
    ["Musubi<hello@musubi.social>", { address: "hello@musubi.social", name: "Musubi" }],
  ])("splits %j into a display name and a bare address", async (raw, expected) => {
    expect(await sentFrom(raw)).toStrictEqual(expected);
  });

  it.each([
    ["<noreply@osn.test>", "noreply@osn.test"],
    ['"  " <noreply@osn.test>', "noreply@osn.test"],
    ["noreply@xn--bcher-kva.example", "noreply@xn--bcher-kva.example"],
    [LONGEST, LONGEST],
  ])("sends %j as a bare address with no name", async (raw, address) => {
    expect(await sentFrom(raw)).toStrictEqual({ address });
  });

  it.each([
    ["", EMPTY],
    ["   ", EMPTY],
    ["Musubi <hello@musubi.social", NOT_A_SENDER],
    ["Musubi hello@musubi.social", NOT_A_SENDER],
    ["Musubi <>", NOT_A_SENDER],
    ["Musubi <not-an-address>", NOT_A_SENDER],
    ["Musubi <hello@musubi.social> extra", NOT_A_SENDER],
    ["a@b.example, c@d.example", NOT_A_SENDER],
    ["hello@localhost", NOT_A_SENDER],
    ['"Musubi <hello@musubi.social>', NOT_A_SENDER],
    ["< hello@musubi.social >", NOT_A_SENDER],
    [".hello@musubi.social", NOT_A_SENDER],
    ["hello.@musubi.social", NOT_A_SENDER],
    ["hel..lo@musubi.social", NOT_A_SENDER],
    ["hello@-musubi.social", NOT_A_SENDER],
    ["hello@musubi-.social", NOT_A_SENDER],
    [`hello@${"b".repeat(64)}.social`, NOT_A_SENDER],
    ['"Caf\\\u00e9" <hello@musubi.social>', NOT_A_SENDER],
    [`${"a".repeat(65)}@musubi.social`, LENGTH],
    [`${LONGEST}d`, LENGTH],
  ])("refuses %j when the layer is built", (raw, message) => {
    expect(refusal(raw)).toBe(message);
  });

  it.each([
    "Musubi\r\nBcc: x@evil.example <hello@musubi.social>",
    '"Mu\nsubi" <hello@musubi.social>',
    "Mu\u202Esubi <hello@musubi.social>",
    "Mu\u200Bsubi <hello@musubi.social>",
    "Mu\u2028subi <hello@musubi.social>",
    "Mu\u2029subi <hello@musubi.social>",
  ])("refuses %j, which holds a control, format or separator character", (raw) => {
    expect(refusal(raw)).toBe(UNSAFE);
  });

  it.each([
    ['"Musubi <dev>" <dev@musubi.social>', { address: "dev@musubi.social", name: "Musubi <dev>" }],
    [
      '"Musubi, Inc." <hello@musubi.social>',
      { address: "hello@musubi.social", name: "Musubi, Inc." },
    ],
    [
      '"The \\"Musubi\\" team" <hello@musubi.social>',
      { address: "hello@musubi.social", name: 'The "Musubi" team' },
    ],
    [
      '"Back\\\\slash" <hello@musubi.social>',
      { address: "hello@musubi.social", name: "Back\\slash" },
    ],
    ['"Musubi"<hello@musubi.social>', { address: "hello@musubi.social", name: "Musubi" }],
  ])("keeps the whole quoted name of %j", async (raw, expected) => {
    expect(await sentFrom(raw)).toStrictEqual(expected);
  });

  it.each([
    'Mus"ubi <hello@musubi.social>',
    "Musubi <dev> <dev@musubi.social>",
    "Musubi > <hello@musubi.social>",
    "a@b.example, Musubi <c@d.example>",
    "support@bank.example <hello@musubi.social>",
    "Musubi: Team <hello@musubi.social>",
    "Musubi; Team <hello@musubi.social>",
    "Musubi [dev] <hello@musubi.social>",
    "Musubi \\ Team <hello@musubi.social>",
  ])("refuses %j, whose unquoted name holds a character only a quoted name may", (raw) => {
    expect(refusal(raw)).toBe(NOT_A_SENDER);
  });

  it("sends from noreply@osn.local when no sender is configured", async () => {
    expect(await sentFrom()).toStrictEqual({ address: "noreply@osn.local" });
  });
});
