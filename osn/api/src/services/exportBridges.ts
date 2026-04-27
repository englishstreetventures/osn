/**
 * S2S export bridges: ARC fan-out from osn/api into pulse/api + zap/api
 * for the DSAR account-export endpoint (C-H1, GDPR Art. 15 + Art. 20).
 *
 * Auth model: shared-secret bearer (`INTERNAL_SERVICE_SECRET`). The reverse
 * direction (pulse/api → osn/api) uses ARC tokens with a service-account
 * key registry hosted in `osn/db`. The forward direction (osn/api → pulse,
 * zap) does not yet have a symmetric ARC verifier on the receiving side
 * (that requires a service-account registry in pulse/db + zap/db). The
 * shared secret matches the pattern already used by
 * `/graph/internal/register-service` and is upgraded to ARC when
 * bidirectional infrastructure lands.
 *
 * Reliability model:
 *   - Per-bridge timeout (10 s, dsar.md §"Fan-out reliability") via
 *     AbortSignal.
 *   - On non-2xx / network failure, the bridge yields a `degraded` line
 *     so the orchestrator's bundle decision becomes `partial` rather
 *     than aborting.
 *   - All outbound HTTP goes through `instrumentedFetch` so the span
 *     becomes a child of the request span and W3C traceparent propagates.
 *   - `metricDsarBridgeOutcome` records every outcome. No accountId in
 *     attributes — that goes in span tags + structured logs only.
 */

import { instrumentedFetch } from "@shared/observability";
import { Data, Effect } from "effect";

import { metricDsarBridgeOutcome } from "../metrics";

const PULSE_API_URL = process.env.PULSE_API_URL ?? "http://localhost:3001";
const ZAP_API_URL = process.env.ZAP_API_URL ?? "http://localhost:3002";

/**
 * Per-bridge timeout. The orchestrator's `Effect.all([...], {
 * concurrency: "unbounded" })` runs both bridges in parallel; a slow
 * bridge cannot stall the whole export beyond this ceiling.
 */
const BRIDGE_TIMEOUT_MS = parseFloat(process.env.OSN_DSAR_BRIDGE_TIMEOUT_MS ?? "10000");

if (process.env.NODE_ENV === "production") {
  // S-H3: in deployed envs the bridge transports must be HTTPS.
  for (const url of [PULSE_API_URL, ZAP_API_URL]) {
    if (!url.startsWith("https://")) {
      throw new Error(`DSAR bridge URL must use https:// in production (got: ${url})`);
    }
  }
}

export class ExportBridgeError extends Data.TaggedError("ExportBridgeError")<{
  readonly service: "pulse" | "zap";
  readonly cause: unknown;
}> {}

/**
 * Per-bundle line shape that matches the orchestrator's NDJSON envelope.
 * The bridges yield raw lines that the service layer wraps into the
 * outer envelope.
 */
export interface BridgeLine {
  readonly raw: string;
}

interface BridgeOpts {
  readonly profileIds: readonly string[];
  /** Optional override for tests — defaults to `process.env.INTERNAL_SERVICE_SECRET`. */
  readonly secret?: string;
}

async function* iterateBridge(
  service: "pulse" | "zap",
  url: string,
  opts: BridgeOpts,
): AsyncIterable<BridgeLine> {
  const secret = opts.secret ?? process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    metricDsarBridgeOutcome(service, "error");
    yield {
      raw: JSON.stringify({
        degraded: service,
        reason: "internal_service_secret_unset",
      }),
    };
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("dsar_bridge_timeout"), BRIDGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await instrumentedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ profileIds: opts.profileIds }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as { name?: string })?.name === "AbortError";
    metricDsarBridgeOutcome(service, aborted ? "timeout" : "error");
    yield {
      raw: JSON.stringify({
        degraded: service,
        reason: aborted ? "timeout" : "network_error",
      }),
    };
    return;
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    metricDsarBridgeOutcome(service, "error");
    yield {
      raw: JSON.stringify({
        degraded: service,
        reason: `http_${res.status}`,
      }),
    };
    return;
  }

  // Stream the NDJSON response line by line, re-emitting each line into
  // the outer bundle. The TextDecoderStream + getReader() combination
  // gives us native back-pressure: the bridge will not buffer the entire
  // sub-bundle in memory.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let rowsSeen = 0;
  let degraded = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // Split on newline; keep the trailing partial chunk in `buffer`.
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (raw.length === 0) continue;
        // Best-effort detect tombstone lines so we can record a degraded
        // outcome even when the bridge replies 200 with an in-band error.
        if (raw.includes('"degraded"')) degraded = true;
        rowsSeen++;
        yield { raw };
      }
    }
    // Flush any remainder (rare — well-formed NDJSON ends with \n).
    if (buffer.length > 0) {
      if (buffer.includes('"degraded"')) degraded = true;
      rowsSeen++;
      yield { raw: buffer };
    }
  } catch {
    metricDsarBridgeOutcome(service, "error");
    yield {
      raw: JSON.stringify({
        degraded: service,
        reason: "stream_read_error",
      }),
    };
    return;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // Reader already released — fine.
    }
  }

  metricDsarBridgeOutcome(service, degraded ? "degraded" : "ok");

  if (rowsSeen === 0) {
    // Empty body is treated as a soft degradation — the upstream endpoint
    // should always at least emit the `{end:true}` sentinel.
    metricDsarBridgeOutcome(service, "degraded");
    yield {
      raw: JSON.stringify({ degraded: service, reason: "empty_response" }),
    };
  }
}

/**
 * Streams Pulse's contribution to the account-export bundle. Yields raw
 * NDJSON lines (already JSON-encoded) that the orchestrator can write
 * directly to the outer response stream.
 */
export const streamPulseExport = (
  opts: BridgeOpts,
): Effect.Effect<AsyncIterable<BridgeLine>, ExportBridgeError> =>
  Effect.sync(() => iterateBridge("pulse", `${PULSE_API_URL}/account-export/internal`, opts)).pipe(
    Effect.withSpan("dsar.bridge.pulse"),
  );

/** Streams Zap's contribution to the account-export bundle. */
export const streamZapExport = (
  opts: BridgeOpts,
): Effect.Effect<AsyncIterable<BridgeLine>, ExportBridgeError> =>
  Effect.sync(() => iterateBridge("zap", `${ZAP_API_URL}/account-export/internal`, opts)).pipe(
    Effect.withSpan("dsar.bridge.zap"),
  );
