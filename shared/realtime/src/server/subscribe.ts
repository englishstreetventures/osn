import { Data, Effect } from "effect";

import { parseTopic, type ParsedTopic, type RealtimeProduct } from "../protocol";
import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "./headers";
import type { HubNamespace } from "./hub-namespace";
import { metricSubscribe, type SubscribeOutcome } from "./metrics";

class SubscribeStepFailed extends Data.TaggedError("SubscribeStepFailed")<{
  readonly step: "authenticate" | "rate_limit" | "authorize" | "hub";
  readonly reason: string;
}> {}

type Refusal = Exclude<SubscribeOutcome, "accepted">;

const REFUSAL_STATUS = {
  not_upgrade: 426,
  bad_origin: 403,
  bad_topic: 404,
  unauthenticated: 401,
  rate_limited: 429,
  denied: 403,
  unavailable: 503,
} as const satisfies Record<Refusal, number>;

export interface SubscribeOptions {
  /** The product serving this route. A topic of any other product is refused. */
  readonly product: RealtimeProduct;
  /** The product's hub binding. Absent ⇒ every request answers 503 and clients fall back. */
  readonly hub: HubNamespace | undefined;
  /**
   * Exact `Origin` values allowed to open a socket — scheme, host and port,
   * no trailing slash. The socket rides the session cookie, so this is the
   * guard against another site opening one in the member's name.
   */
  readonly allowedOrigins: readonly string[];
  /** The product's rule for entity and id, applied after the shared pattern. */
  readonly acceptsTopic: (topic: ParsedTopic) => boolean;
  /** The caller's subject from the product's normal session auth, or null. */
  readonly authenticate: (request: Request) => Promise<string | null>;
  /** The product's rate limiter, keyed on the subject: true to proceed. */
  readonly allow: (subject: string) => Promise<boolean>;
  /** The product's membership check: may `subject` read `topic`'s entity? */
  readonly authorize: (subject: string, topic: ParsedTopic) => Promise<boolean>;
}

const decodeTopic = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/**
 * Admit one WebSocket upgrade for `rawTopic` (the path segment, still
 * percent-encoded), or refuse it with a plain HTTP status. Checks run cheapest
 * first and nothing after a refusal runs. On success the hub's 101 response is
 * returned untouched: the product must hand that exact object back to the
 * runtime, never through a framework that rebuilds responses — a rebuilt 101
 * loses its socket.
 */
export const subscribe = (
  request: Request,
  rawTopic: string,
  options: SubscribeOptions,
): Effect.Effect<Response> => {
  const refuse = (outcome: Refusal): Effect.Effect<Response> =>
    Effect.sync(() => {
      metricSubscribe(options.product, outcome);
      return new Response(null, {
        status: REFUSAL_STATUS[outcome],
        headers: outcome === "rate_limited" ? { "retry-after": "60" } : {},
      });
    });

  const step = <A>(name: SubscribeStepFailed["step"], run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new SubscribeStepFailed({ step: name, reason: String(cause) }),
    });

  return Effect.gen(function* () {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return yield* refuse("not_upgrade");
    }
    const origin = request.headers.get("origin");
    if (origin === null || !options.allowedOrigins.includes(origin))
      return yield* refuse("bad_origin");

    const topic = decodeTopic(rawTopic);
    const parsed = topic === null ? null : parseTopic(topic);
    if (
      topic === null ||
      parsed === null ||
      parsed.product !== options.product ||
      !options.acceptsTopic(parsed)
    ) {
      return yield* refuse("bad_topic");
    }

    const hub = options.hub;
    if (!hub) return yield* refuse("unavailable");

    const subject = yield* step("authenticate", () => options.authenticate(request));
    if (!subject) return yield* refuse("unauthenticated");
    const allowed = yield* step("rate_limit", () => options.allow(subject));
    if (!allowed) return yield* refuse("rate_limited");
    const member = yield* step("authorize", () => options.authorize(subject, parsed));
    if (!member) return yield* refuse("denied");

    const upgrade = new Request(request.url, {
      headers: { upgrade: "websocket", [HUB_TOPIC_HEADER]: topic, [HUB_SUBJECT_HEADER]: subject },
    });
    const response = yield* step("hub", () => hub.getByName(topic).fetch(upgrade));
    if (response.status !== 101) {
      yield* Effect.logError("realtime hub refused an admitted upgrade", {
        status: response.status,
      });
      return yield* refuse("unavailable");
    }
    yield* Effect.sync(() => metricSubscribe(options.product, "accepted"));
    return response;
  }).pipe(
    Effect.catchTag("SubscribeStepFailed", (failure) =>
      Effect.logError("realtime subscribe failed", {
        step: failure.step,
        reason: failure.reason,
      }).pipe(Effect.andThen(refuse("unavailable"))),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError("realtime subscribe failed on a defect", { reason: String(defect) }).pipe(
        Effect.andThen(refuse("unavailable")),
      ),
    ),
    Effect.withSpan("realtime.subscribe", { attributes: { "realtime.product": options.product } }),
  );
};
