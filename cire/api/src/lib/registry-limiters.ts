import { createWorkersRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend, WorkersRateLimitBinding } from "@shared/rate-limit";
import { Effect } from "effect";

import type { AppOptions } from "../app";
import { RateLimiterUnbound } from "../middleware/rate-limit";
import { runCire } from "../observability";

/** The native bindings behind the registry routes that fetch a URL the caller chose. */
export interface RegistryLimiterBindings {
  REGISTRY_PREVIEW_RATE_LIMITER?: WorkersRateLimitBinding;
  REGISTRY_IMAGE_RATE_LIMITER?: WorkersRateLimitBinding;
  REGISTRY_THUMB_RATE_LIMITER?: WorkersRateLimitBinding;
}

type RegistryLimiterOptions = Pick<
  AppOptions,
  "registryPreviewLimiter" | "registryImageLimiter" | "registryThumbLimiter"
>;

/**
 * A limiter for a deployed tier whose binding is missing. Every call logs the
 * misconfiguration and throws {@link RateLimiterUnbound}, which the per-user
 * middleware answers with 503. Counting in memory instead would count per
 * isolate, a bound the caller widens by spreading requests across isolates.
 */
function unboundLimiter(binding: keyof RegistryLimiterBindings): RateLimiterBackend {
  return {
    async check() {
      await runCire(
        Effect.logError(`${binding} binding missing in a deployed tier`, {
          detail: "refusing the route rather than count per isolate",
        }),
      );
      throw new RateLimiterUnbound(binding);
    },
  };
}

/**
 * The limiters for the link preview, the image save and the picker's
 * thumbnails. Each of those routes spends an outbound fetch on a URL the caller
 * chose, and the thumbnail an Images transform too.
 *
 *  - binding present: the native limiter.
 *  - binding missing in a deployed tier: a limiter that refuses with 503, so
 *    only these routes stop and the rest of the Worker serves. The image limiter
 *    also covers the upload leg of the save; both legs share one budget and
 *    both write to R2.
 *  - binding missing locally: left out, so `createApp` uses its in-memory
 *    default and `bun run dev` works without the binding.
 */
export function registryOutboundLimiters(
  env: RegistryLimiterBindings,
  deployed: boolean,
): RegistryLimiterOptions {
  const pick = (name: keyof RegistryLimiterBindings): RateLimiterBackend | undefined => {
    const binding = env[name];
    if (binding) return createWorkersRateLimiter(binding);
    return deployed ? unboundLimiter(name) : undefined;
  };
  const out: RegistryLimiterOptions = {};
  const preview = pick("REGISTRY_PREVIEW_RATE_LIMITER");
  const image = pick("REGISTRY_IMAGE_RATE_LIMITER");
  const thumb = pick("REGISTRY_THUMB_RATE_LIMITER");
  if (preview) out.registryPreviewLimiter = preview;
  if (image) out.registryImageLimiter = image;
  if (thumb) out.registryThumbLimiter = thumb;
  return out;
}
