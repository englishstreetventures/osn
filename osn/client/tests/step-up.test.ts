import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import type { AuthFetch } from "../src/runtime";
import {
  createStepUpClient,
  STEP_UP_DEADLINE_MS,
  StepUpError,
  type StepUpClient,
} from "../src/step-up";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const errResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

describe("createStepUpClient", () => {
  const client = createStepUpClient({ issuerUrl: "https://osn.example.com", authFetch });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expectAllThroughAuthFetch(authFetch, "include");
    vi.unstubAllGlobals();
  });

  describe("passkeyBegin", () => {
    it("POSTs /step-up/passkey/begin through authFetch and returns the challenge options", async () => {
      fetchMock.mockResolvedValue(okResponse({ options: { challenge: "abc" } }));
      const result = await client.passkeyBegin();
      expect(result).toEqual({ options: { challenge: "abc" } });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://osn.example.com/step-up/passkey/begin");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    });
  });

  describe("passkeyComplete", () => {
    it("returns the parsed step-up token envelope", async () => {
      fetchMock.mockResolvedValue(okResponse({ step_up_token: "eyJabc", expires_in: 300 }));
      const result = await client.passkeyComplete({
        assertion: { id: "x" },
      });
      expect(result).toEqual({ token: "eyJabc", expiresIn: 300 });
    });
  });

  describe("emailStatus", () => {
    const poll = () =>
      client.emailStatus({
        requestId: "stepup_0123456789ab",
        claimSecret: "c".repeat(64),
      });

    it("parses the token from a complete answer", async () => {
      fetchMock.mockResolvedValue(
        okResponse({ status: "complete", step_up_token: "eyJlink", expires_in: 300 }),
      );
      expect(await poll()).toEqual({
        status: "complete",
        token: { token: "eyJlink", expiresIn: 300 },
      });
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://osn.example.com/step-up/email/stepup_0123456789ab/status");
    });

    it("reads a refusal as expired and throws on a transient", async () => {
      fetchMock.mockResolvedValueOnce(errResponse({ error: "invalid_request" }));
      expect(await poll()).toEqual({ status: "expired" });
      for (const status of [429, 503]) {
        fetchMock.mockResolvedValueOnce(new Response("{}", { status }));
        await expect(poll()).rejects.toThrow(StepUpError);
      }
    });
  });

  describe("the deadline", () => {
    const requestId = "stepup_0123456789ab";
    const claimSecret = "c".repeat(64);
    const token = { step_up_token: "eyJabc", expires_in: 300 };
    const link = { requestId, claimSecret, pairingCode: "42", expiresAt: 1_900_000_000 };

    /** Each method, how to call it, an answer its route sends, and what the call resolves to. */
    const METHODS = [
      [
        "passkeyBegin",
        (c: StepUpClient) => c.passkeyBegin(),
        { options: { challenge: "abc" } },
        { options: { challenge: "abc" } },
      ],
      [
        "passkeyComplete",
        (c: StepUpClient) => c.passkeyComplete({ assertion: {} }),
        token,
        { token: "eyJabc", expiresIn: 300 },
      ],
      ["emailBegin", (c: StepUpClient) => c.emailBegin({ purpose: "account_export" }), link, link],
      [
        "emailStatus",
        (c: StepUpClient) => c.emailStatus({ requestId, claimSecret }),
        { status: "pending", pairingCode: "42" },
        { status: "pending", pairingCode: "42" },
      ],
      [
        "emailResend",
        (c: StepUpClient) => c.emailResend({ requestId, claimSecret }),
        { status: "sent" },
        { status: "sent" },
      ],
      [
        "totpComplete",
        (c: StepUpClient) => c.totpComplete({ code: "123456" }),
        token,
        { token: "eyJabc", expiresIn: 300 },
      ],
    ] as const;

    // Taken before any test fakes it: `settle` waits on a real macrotask.
    const realSetTimeout = globalThis.setTimeout;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Runs every promise job queued so far, and those they queue. */
    const settle = () => new Promise<void>((done) => realSetTimeout(done, 0));

    /** The call's outcome, read without waiting for it. */
    function watch(promise: Promise<unknown>) {
      const outcome: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
      promise.then(
        (value) => Object.assign(outcome, { settled: true, value }),
        (error: unknown) => Object.assign(outcome, { settled: true, error }),
      );
      return outcome;
    }

    /**
     * A request the server never answers, as `fetch` leaves one: pending until
     * its signal aborts, then rejected with the signal's reason.
     */
    function unanswered(init: RequestInit | undefined): Promise<Response> {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }

    /**
     * A 200 whose body starts and never ends, and fails with the signal's
     * reason once its signal aborts, as the body of a `fetch` response does.
     */
    function bodyNeverEnds(init: RequestInit | undefined): Response {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"status":'));
          signal?.addEventListener("abort", () => stream.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }

    /** Pending a millisecond before the deadline; a `StepUpError` at status 0 at it. */
    async function expectRejectedAtDeadline(outcome: ReturnType<typeof watch>) {
      await vi.advanceTimersByTimeAsync(STEP_UP_DEADLINE_MS - 1);
      await settle();
      expect(outcome.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(StepUpError);
      expect(outcome.error).toMatchObject({ status: 0, code: undefined });
    }

    it.each(METHODS)(
      "F1/F2 %s: a request left unanswered rejects at the deadline at status 0, and is aborted",
      async (_name, call) => {
        const signals: (AbortSignal | undefined)[] = [];
        fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
          signals.push(init?.signal ?? undefined);
          return unanswered(init);
        });
        const outcome = watch(call(client));
        await expectRejectedAtDeadline(outcome);
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(true);
      },
    );

    it.each(METHODS)(
      "F3 %s: a body that never ends rejects at the deadline at status 0",
      async (_name, call) => {
        fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
          Promise.resolve(bodyNeverEnds(init)),
        );
        await expectRejectedAtDeadline(watch(call(client)));
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it.each(METHODS)(
      "F4 %s: a wait inside authFetch that ignores the signal rejects at the deadline",
      async (_name, call) => {
        const hung = vi.fn<AuthFetch>(() => new Promise<Response>(() => {}));
        const stalled = createStepUpClient({
          issuerUrl: "https://osn.example.com",
          authFetch: hung,
        });
        await expectRejectedAtDeadline(watch(call(stalled)));
        expect(hung).toHaveBeenCalledTimes(1);
      },
    );

    it.each(METHODS)(
      "F5 %s: an answer before the deadline resolves as before and leaves no timer",
      async (_name, call, answer, expected) => {
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return Promise.resolve(okResponse(answer));
        });
        await expect(call(client)).resolves.toEqual(expected);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(STEP_UP_DEADLINE_MS);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
      },
    );
  });
});
