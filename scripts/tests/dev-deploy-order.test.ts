// The order check's fetch, alone: every dev stack job that is not at main's
// newest commit depends on api.github.com before it deploys, and fails
// closed when it cannot read it. A blip must not cost a deploy, and a hung
// request must not hold the stack's concurrency group for the job's whole
// time limit. The CLI tier (dev-deploy-order.cli.test.ts) cannot wait out
// real delays and timeouts, so these run with short ones.

import { expect, test } from "bun:test";

import { retryingFetch } from "../dev-deploy-order";

const FAST = { timeoutMs: 50, delays: [1, 1] } as const;

/** A fetch that answers each call with the next of `answers`: a status, or "hang". */
function scripted(answers: readonly (number | "hang" | "network")[]) {
  const calls: (AbortSignal | undefined)[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const answer = answers[calls.length] ?? 200;
    calls.push(init?.signal ?? undefined);
    if (answer === "network") throw new TypeError("fetch failed");
    if (answer === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    return new Response(String(answer), { status: answer });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("F12a: a 5xx, a 429, a network error or a hung request is tried again, up to twice, and the answer after it is used", async () => {
  for (const first of [502, 503, 429, "network", "hang"] as const) {
    const { fetcher, calls } = scripted([first, 200]);
    const response = await retryingFetch(fetcher, FAST)("https://api.github.com/x");
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  }
});

test("a request that keeps failing is tried three times, then its last answer is returned for the reader to refuse", async () => {
  const { fetcher, calls } = scripted([502, 502, 502, 200]);
  const response = await retryingFetch(fetcher, FAST)("https://api.github.com/x");
  expect(response.status).toBe(502);
  expect(calls).toHaveLength(3);
});

test("a request that keeps hanging fails after three tries", async () => {
  const { fetcher, calls } = scripted(["hang", "hang", "hang"]);
  await expect(retryingFetch(fetcher, FAST)("https://api.github.com/x")).rejects.toThrow();
  expect(calls).toHaveLength(3);
});

test("an answer no retry can change (a 401, a 404) is returned at once", async () => {
  for (const status of [401, 403, 404]) {
    const { fetcher, calls } = scripted([status, 200]);
    const response = await retryingFetch(fetcher, FAST)("https://api.github.com/x");
    expect(response.status).toBe(status);
    expect(calls).toHaveLength(1);
  }
});

test("every try carries a time limit", async () => {
  const { fetcher, calls } = scripted([502, 200]);
  await retryingFetch(fetcher, FAST)("https://api.github.com/x");
  expect(calls.every((signal) => signal instanceof AbortSignal)).toBe(true);
});
