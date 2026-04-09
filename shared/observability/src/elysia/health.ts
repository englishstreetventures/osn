import { Effect } from "effect";
import { Elysia } from "elysia";

/**
 * Standard health + readiness routes.
 *
 * - `/health` is **liveness**: returns 200 as long as the process is up.
 *   It never does real work. Use for container liveness probes; if this
 *   returns non-200, restart the container.
 *
 * - `/ready` is **readiness**: returns 200 only if the service can
 *   actually serve traffic (i.e. dependencies are reachable). The caller
 *   supplies an optional `probe` function that returns a boolean; any
 *   thrown error or false return is treated as "not ready" → 503.
 *
 * Convention borrowed from Kubernetes; works on Fly.io / Render / Railway
 * / bare Docker without modification.
 *
 * IMPORTANT (S-H1): these routes are **unauthenticated** and publicly
 * reachable. Response bodies are deliberately opaque — never include
 * driver text, file paths, connection strings, or any other internal
 * detail. Probe failures are logged via `Effect.logError` for
 * operators; callers see a fixed `{ status: "not_ready" }` shape.
 */
export interface HealthRoutesOptions {
  /** Service name, returned in the body so operators can sanity-check. */
  readonly serviceName: string;
  /**
   * Optional readiness probe. Return true if ready, false or throw if not.
   * Typical implementation: a trivial DB query (`SELECT 1`).
   */
  readonly probe?: () => Promise<boolean> | boolean;
}

export const healthRoutes = (options: HealthRoutesOptions) =>
  new Elysia({ name: "@shared/observability/health" })
    .get("/health", () => ({
      status: "ok",
      service: options.serviceName,
    }))
    .get("/ready", async ({ set }) => {
      if (!options.probe) {
        return { status: "ready", service: options.serviceName };
      }
      try {
        const ok = await options.probe();
        if (!ok) {
          set.status = 503;
          // Operator-side log so we know WHY ready returned false.
          void Effect.runPromise(
            Effect.logWarning("readiness probe returned false").pipe(
              Effect.annotateLogs({ service: options.serviceName }),
            ),
          );
          return { status: "not_ready", service: options.serviceName };
        }
        return { status: "ready", service: options.serviceName };
      } catch (err) {
        set.status = 503;
        // S-H1: log the underlying error for operators but do NOT
        // return it to the caller. The body shape is identical to
        // the `ok === false` branch so external callers cannot
        // distinguish "probe threw" from "probe returned false".
        void Effect.runPromise(
          Effect.logError("readiness probe threw").pipe(
            Effect.annotateLogs({
              service: options.serviceName,
              cause: err instanceof Error ? err.message : String(err),
            }),
          ),
        );
        return { status: "not_ready", service: options.serviceName };
      }
    });
