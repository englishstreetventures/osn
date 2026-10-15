/**
 * The probe Worker deployed by `alchemy.run.ts`, once for Cire and once for
 * OSN. It answers one route, `GET /health`, to callers holding the probe
 * token, and proves only that each adopted binding is attached and reachable:
 * D1 runs `SELECT 1`, each Cire R2 bucket lists at most one key, and the
 * Images and rate-limit bindings exist. It returns no stored data and never
 * calls a rate limiter, whose counters it shares with the routed dev Worker.
 */

/** Shortest probe token the Worker accepts; anything shorter fails closed. */
export const MIN_PROBE_TOKEN_LENGTH = 32;

type Database = {
  prepare(query: string): { first<T>(): Promise<T | null> };
};

type Bucket = {
  list(options: { limit: number }): Promise<{ objects: readonly { key: string }[] }>;
};

export type ProbeEnv = {
  PROBE_PRODUCT: "cire" | "osn";
  PROBE_TOKEN: string;
  DB: Database;
  SHEETS?: Bucket;
  ASSETS?: Bucket;
  IMAGES?: object;
  CLAIM_RATE_LIMITER?: object;
  RL_AUTH_IP_5_60?: object;
};

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * True when two equal-length digests match, after comparing every byte pair
 * whatever the result so far.
 */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

/**
 * Compares two strings in time that depends on neither their contents nor
 * where they first differ: both are hashed to 32 bytes and every byte pair is
 * compared. Runs the same way under Bun and workerd.
 */
export async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return sameDigest(a, b);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

async function bindingsHealthy(env: ProbeEnv): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  if (row?.ok !== 1) return false;

  if (env.PROBE_PRODUCT === "cire") {
    if (!env.SHEETS || !env.ASSETS || !env.IMAGES || !env.CLAIM_RATE_LIMITER) return false;
    await Promise.all([env.SHEETS.list({ limit: 1 }), env.ASSETS.list({ limit: 1 })]);
    return true;
  }
  return Boolean(env.RL_AUTH_IP_5_60);
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }

    if (typeof env.PROBE_TOKEN !== "string" || env.PROBE_TOKEN.length < MIN_PROBE_TOKEN_LENGTH) {
      return new Response("Probe token not configured", { status: 503 });
    }

    const presented = bearerToken(request);
    if (presented === undefined || !(await tokensMatch(presented, env.PROBE_TOKEN))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const healthy = await bindingsHealthy(env).catch(() => false);
    if (!healthy) {
      return new Response(`${env.PROBE_PRODUCT} binding probe failed`, { status: 503 });
    }
    return Response.json({ product: env.PROBE_PRODUCT, ok: true });
  },
};
