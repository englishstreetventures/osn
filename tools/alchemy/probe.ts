type Database = {
  prepare(query: string): { first<T>(): Promise<T | null> };
};

type ProbeEnv = {
  PROBE_PRODUCT: "cire" | "osn";
  DB: Database;
  SHEETS?: { list(options: { limit: number }): Promise<{ objects: readonly { key: string }[] }> };
  ASSETS?: { list(options: { limit: number }): Promise<{ objects: readonly { key: string }[] }> };
  IMAGES?: object;
  CLAIM_RATE_LIMITER?: object;
  RL_AUTH_IP_5_60?: object;
};

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }

    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) {
      return new Response("D1 probe failed", { status: 503 });
    }

    if (env.PROBE_PRODUCT === "cire") {
      if (!env.SHEETS || !env.ASSETS || !env.IMAGES || !env.CLAIM_RATE_LIMITER) {
        return new Response("Cire binding probe failed", { status: 503 });
      }
      await Promise.all([env.SHEETS.list({ limit: 1 }), env.ASSETS.list({ limit: 1 })]);
    } else if (!env.RL_AUTH_IP_5_60) {
      return new Response("OSN binding probe failed", { status: 503 });
    }

    return Response.json({ product: env.PROBE_PRODUCT, ok: true });
  },
};
