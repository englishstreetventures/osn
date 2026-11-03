import { Data, Effect } from "effect";

/**
 * How far a webhook's timestamp may be from ours before it is refused, in
 * seconds. Stripe's own default. A valid signature is valid forever, so without
 * a window a captured delivery could be replayed at any later time.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** A webhook body that did not come from Stripe, or came too long ago. */
export class StripeSignatureError extends Data.TaggedError("StripeSignatureError")<{
  readonly reason: "malformed" | "no-match" | "too-old" | "unconfigured";
}> {}

interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key?.trim() === "t" && value) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
    // v0 is the test-mode scheme: only v1 is computed over the payload trusted.
    if (key?.trim() === "v1" && value) signatures.push(value.trim());
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Comparison with no length- or value-dependent early exit over the digest. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a webhook delivery and return its parsed body.
 *
 * The signature is over the exact bytes Stripe sent, so this takes the body as
 * TEXT and parses it afterwards. Three checks: the header parses, a v1 digest
 * matches (every candidate compared, so timing says nothing about which), and
 * the timestamp is inside the tolerance window.
 */
export function verifyStripeWebhook(input: {
  payload: string;
  signatureHeader: string | null;
  secret: string | null;
  /** Unix seconds. Injected so the tolerance window is testable. */
  now: number;
  toleranceSeconds?: number;
}): Effect.Effect<unknown, StripeSignatureError> {
  return Effect.gen(function* () {
    // No secret ⇒ nothing can be verified, so nothing is accepted.
    const secret = input.secret;
    if (!secret) return yield* Effect.fail(new StripeSignatureError({ reason: "unconfigured" }));
    if (!input.signatureHeader) {
      return yield* Effect.fail(new StripeSignatureError({ reason: "malformed" }));
    }
    const parsed = parseSignatureHeader(input.signatureHeader);
    if (!parsed) return yield* Effect.fail(new StripeSignatureError({ reason: "malformed" }));

    const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
    if (Math.abs(input.now - parsed.timestamp) > tolerance) {
      return yield* Effect.fail(new StripeSignatureError({ reason: "too-old" }));
    }

    const encoder = new TextEncoder();
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    );
    const digest = yield* Effect.promise(() =>
      crypto.subtle.sign("HMAC", key, encoder.encode(`${parsed.timestamp}.${input.payload}`)),
    );
    const expected = toHex(digest);
    // Several v1 digests arrive while a secret rotates; any one matching is a
    // valid delivery. No early return, so the loop's timing names none.
    let matched = false;
    for (const candidate of parsed.signatures) {
      if (timingSafeEqualHex(candidate, expected)) matched = true;
    }
    if (!matched) return yield* Effect.fail(new StripeSignatureError({ reason: "no-match" }));

    return yield* Effect.try({
      try: () => JSON.parse(input.payload) as unknown,
      catch: () => new StripeSignatureError({ reason: "malformed" }),
    });
  });
}
