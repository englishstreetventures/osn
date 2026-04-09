import { Layer } from "effect";

/**
 * No-op tracing layer for tests and local runs that don't want to touch
 * OTel at all. Provides no resources and never exports anything.
 *
 * Use this in test `createTestLayer()` helpers so that running `bun test`
 * doesn't try to connect to an OTLP endpoint.
 */
export const NoopTracingLive: Layer.Layer<never> = Layer.empty;
