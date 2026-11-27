/**
 * A mail provider that dedupes on idempotency keys as Resend does, for the
 * change-notice tests: a key it has accepted answers its stored result for the
 * same payload and delivers nothing; a different payload under it answers 409
 * `invalid_idempotent_request`; a second request while the first is in flight
 * answers 409 `concurrent_idempotent_requests`. A test scripts the answers it
 * needs, one step per new request, and reads what was delivered.
 *
 * Imports no test framework: the D1 tier runs under `bun test`.
 */

import {
  EmailError,
  type EmailServiceImpl,
  type KeyedBatchResult,
  type SendEmailInput,
} from "@shared/email";
import { Deferred, Effect } from "effect";

export type Step =
  | "accept"
  /** Resend took the batch, and the answer never came back. */
  | "accept-then-503"
  | "503"
  | "429"
  /** A 429 before the key is looked at, as a rate limit in front of the API answers. */
  | "429-early"
  | "422"
  /** Never answers: the route's timeout ends the wait. */
  | "hang"
  /** The transport dies: a defect, not a typed failure. */
  | "defect"
  /** The template does not render: nothing is sent. */
  | "render-failed"
  | { readonly refuse: readonly number[] }
  /** Answers once `release` completes. */
  | { readonly hold: Deferred.Deferred<void> };

export function fakeResend() {
  const delivered: { to: string; key: string; subject: string; data: SendEmailInput["data"] }[] =
    [];
  const stored = new Map<string, { payload: string; result: KeyedBatchResult }>();
  const inFlight = new Set<string>();
  const script: Step[] = [];
  const calls: { key: string; to: string[] }[] = [];

  const refuse = (status: number, providerError?: string) =>
    Effect.fail(
      providerError === undefined
        ? new EmailError({ reason: status === 429 ? "rate_limited" : "dispatch_failed", status })
        : new EmailError({ reason: "dispatch_failed", status, providerError }),
    );

  const deliver = (inputs: readonly SendEmailInput[], key: string, skip: readonly number[]) => {
    inputs.forEach((input, i) => {
      if (!skip.includes(i)) {
        delivered.push({ to: input.to, key, subject: input.template, data: input.data });
      }
    });
    const result = { accepted: inputs.length - skip.length, refused: skip.length };
    stored.set(key, { payload: JSON.stringify(inputs), result });
    return result;
  };

  const sendKeyedBatch = (
    inputs: readonly SendEmailInput[],
    { idempotencyKey: key }: { readonly idempotencyKey: string },
  ): Effect.Effect<KeyedBatchResult, EmailError> =>
    Effect.gen(function* () {
      calls.push({ key, to: inputs.map((input) => input.to) });
      if (script[0] === "429-early") {
        script.shift();
        return yield* refuse(429, "rate_limit_exceeded");
      }
      if (inFlight.has(key)) return yield* refuse(409, "concurrent_idempotent_requests");
      const seen = stored.get(key);
      if (seen !== undefined) {
        return seen.payload === JSON.stringify(inputs)
          ? seen.result
          : yield* refuse(409, "invalid_idempotent_request");
      }
      const step = script.shift() ?? "accept";
      if (step === "accept") return deliver(inputs, key, []);
      if (step === "accept-then-503") {
        deliver(inputs, key, []);
        return yield* refuse(503);
      }
      if (step === "503") return yield* refuse(503);
      if (step === "429") return yield* refuse(429, "daily_quota_exceeded");
      if (step === "429-early") return yield* refuse(429, "rate_limit_exceeded");
      if (step === "422") return yield* refuse(422, "validation_error");
      if (step === "hang") return yield* Effect.never;
      if (step === "defect") return yield* Effect.die(new Error("transport defect"));
      if (step === "render-failed") {
        return yield* Effect.fail(new EmailError({ reason: "render_failed" }));
      }
      if ("refuse" in step) return deliver(inputs, key, step.refuse);
      inFlight.add(key);
      yield* Deferred.await(step.hold);
      inFlight.delete(key);
      return deliver(inputs, key, []);
    });

  const service: EmailServiceImpl = {
    send: () => Effect.die("the change notice never sends one message at a time"),
    sendKeyedBatch,
  };
  return { delivered, calls, script, service };
}
