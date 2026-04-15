/**
 * Env-driven observability config. Parsed once at boot.
 *
 * All values have sensible defaults so the library is a no-op when run
 * locally without any env vars set: logs go to stdout (pretty), tracing
 * and metrics exporters are disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is present.
 */

export type DeploymentEnvironment = "dev" | "staging" | "production";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface ObservabilityConfig {
  /** Service name, e.g. "pulse-api" — becomes `service.name` resource attribute. */
  readonly serviceName: string;
  /** Service version, e.g. "0.4.4" — becomes `service.version`. */
  readonly serviceVersion: string;
  /** Always "osn" — becomes `service.namespace`. */
  readonly serviceNamespace: string;
  /** `<hostname>-<pid>` — becomes `service.instance.id`. */
  readonly serviceInstanceId: string;
  /** Deployment environment — becomes `deployment.environment`. */
  readonly env: DeploymentEnvironment;
  /** Minimum log level to emit. */
  readonly logLevel: LogLevel;
  /** OTLP exporter endpoint (HTTP). If unset, exporters are disabled. */
  readonly otlpEndpoint: string | undefined;
  /** Optional headers for the OTLP exporter (e.g. auth tokens for SaaS). */
  readonly otlpHeaders: Record<string, string>;
  /** Trace sampling ratio in [0, 1]. Defaults to 1.0 in dev, 0.1 in prod. */
  readonly traceSampleRatio: number;
}

const parseEnv = (value: string | undefined): DeploymentEnvironment => {
  switch (value) {
    case "production":
    case "prod":
      return "production";
    case "staging":
    case "stage":
      return "staging";
    default:
      return "dev";
  }
};

const parseLogLevel = (value: string | undefined, env: DeploymentEnvironment): LogLevel => {
  switch (value) {
    case "trace":
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
      return value;
    default:
      return env === "dev" ? "debug" : "info";
  }
};

/**
 * S-M1: strict OTLP header parser.
 *
 * These headers are passed straight to the OTLP HTTP exporter and
 * typically include the Grafana Cloud / Axiom / etc. Authorization
 * token. Malformed values (CRLF, control chars, spaces) must NOT reach
 * the HTTP layer — they enable header smuggling attacks against the
 * collector. We throw on malformed input rather than silently dropping
 * so misconfiguration crashes loudly at boot.
 */
const HEADER_KEY_RE = /^[A-Za-z0-9-]+$/;
// Values: any printable ASCII except CR/LF. OTLP uses tokens, base64,
// and JWT-like strings as auth headers; this range covers all of them.
const HEADER_VALUE_RE = /^[\x20-\x7E]+$/;

const parseHeaders = (value: string | undefined): Record<string, string> => {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key) continue;
    if (!HEADER_KEY_RE.test(key)) {
      throw new Error(
        `OTEL_EXPORTER_OTLP_HEADERS: invalid header name "${key}" (expected [A-Za-z0-9-]+)`,
      );
    }
    if (!HEADER_VALUE_RE.test(val)) {
      throw new Error(
        `OTEL_EXPORTER_OTLP_HEADERS: invalid value for "${key}" (control characters or CRLF not allowed)`,
      );
    }
    out[key] = val;
  }
  return out;
};

const parseSampleRatio = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || n > 1) return fallback;
  return n;
};

const instanceId = (serviceName: string): string => {
  const host = typeof process !== "undefined" ? process.env.HOSTNAME || "local" : "local";
  const pid = typeof process !== "undefined" ? String(process.pid) : "0";
  return `${serviceName}-${host}-${pid}`;
};

export interface ConfigOverrides {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly env?: DeploymentEnvironment;
}

export const loadConfig = (overrides: ConfigOverrides = {}): ObservabilityConfig => {
  const env = overrides.env ?? parseEnv(process.env.OSN_ENV ?? process.env.NODE_ENV ?? undefined);

  // S-L3: if anything claims we're in production, require an explicit
  // `OSN_ENV=production` — `NODE_ENV` alone is not sufficient because
  // Bun leaves it empty by default and a missing env would silently
  // classify as `dev` (pretty logs + 100% trace sampling + any future
  // dev-only code paths). Conversely, if the operator DID set
  // `OSN_ENV=production` but an override tries to force it elsewhere,
  // that's a bug we want to hear about.
  if (process.env.OSN_ENV === "production" && env !== "production") {
    throw new Error(
      `loadConfig: OSN_ENV=production in the environment but resolved env is "${env}". Refusing to boot with a mismatched environment.`,
    );
  }

  const serviceName = overrides.serviceName ?? process.env.OSN_SERVICE_NAME ?? "osn-service";
  const serviceVersion = overrides.serviceVersion ?? process.env.OSN_SERVICE_VERSION ?? "0.0.0";

  return {
    serviceName,
    serviceVersion,
    serviceNamespace: "osn",
    serviceInstanceId: instanceId(serviceName),
    env,
    logLevel: parseLogLevel(process.env.OSN_LOG_LEVEL, env),
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otlpHeaders: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    traceSampleRatio: parseSampleRatio(
      process.env.OSN_TRACE_SAMPLE_RATIO,
      env === "production" ? 0.1 : 1.0,
    ),
  };
};
