import type { RedisClient } from "./client";

/**
 * Redis health probe for `/ready` endpoints.
 *
 * Sends a PING with a timeout. Returns `true` if the server replies "PONG"
 * within the deadline, `false` otherwise. The timeout timer is always cleaned
 * up regardless of outcome (P-I1/S-L1).
 */
export async function checkRedisHealth(client: RedisClient, timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      client.ping().finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis health check timed out")), timeoutMs);
      }),
    ]);
    return result === "PONG";
  } catch {
    return false;
  }
}
