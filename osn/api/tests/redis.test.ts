import { Layer } from "effect";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { initRedisClient } from "../src/redis";

// Mock the ioredis subpath to avoid real ioredis connections. `createClientFromUrl`
// now lives in `@shared/redis/ioredis` (split out so it never lands in the Workers
// bundle), so the mock targets that module rather than the top-level entry.
vi.mock("@shared/redis/ioredis", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Override createClientFromUrl to return a controllable mock
    createClientFromUrl: vi.fn(),
  };
});

import { createMemoryClient } from "@shared/redis";
import { createClientFromUrl, type ConnectableRedisClient } from "@shared/redis/ioredis";

const mockedCreateClientFromUrl = vi.mocked(createClientFromUrl);

function mockFn<T>(returnValue: T): () => Promise<T> {
  return vi.fn().mockResolvedValue(returnValue) as unknown as () => Promise<T>;
}
function mockFnReject<T>(err: Error): () => Promise<T> {
  return vi.fn().mockRejectedValue(err) as unknown as () => Promise<T>;
}

function createMockConnectableClient(
  overrides: Partial<ConnectableRedisClient> = {},
): ConnectableRedisClient {
  const base = createMemoryClient();
  return {
    ...base,
    connect: mockFn(undefined),
    disconnect: mockFn(undefined),
    ...overrides,
  };
}

const silentLogger = Layer.empty;

describe("initRedisClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Branch 1: REDIS_URL not set
  // -------------------------------------------------------------------------

  it("returns an in-memory client when redisUrl is undefined", async () => {
    const client = await initRedisClient({
      redisUrl: undefined,
      loggerLayer: silentLogger,
    });

    // Should work as a rate limiter backend (in-memory)
    expect(await client.ping()).toBe("PONG");
    expect(mockedCreateClientFromUrl).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Branch 2: REDIS_URL set + healthy
  // -------------------------------------------------------------------------

  it("returns the Redis client when health check passes", async () => {
    const mockClient = createMockConnectableClient();
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    const client = await initRedisClient({
      redisUrl: "redis://localhost:6379",
      loggerLayer: silentLogger,
    });

    expect(mockedCreateClientFromUrl).toHaveBeenCalledWith("redis://localhost:6379");
    expect(mockClient.connect).toHaveBeenCalledOnce();
    expect(client).toBe(mockClient);
  });

  // -------------------------------------------------------------------------
  // Branch 3: REDIS_URL set + connection fails → fallback
  // -------------------------------------------------------------------------

  it("falls back to in-memory when connect() throws", async () => {
    const mockClient = createMockConnectableClient({
      connect: mockFnReject(new Error("ECONNREFUSED")),
    });
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    const client = await initRedisClient({
      redisUrl: "redis://localhost:6379",
      loggerLayer: silentLogger,
    });

    // Should return a working in-memory client, not the failed one
    expect(client).not.toBe(mockClient);
    expect(await client.ping()).toBe("PONG");
  });

  it("falls back to in-memory when health check returns false", async () => {
    const mockClient = createMockConnectableClient({
      ping: mockFn("NOT_PONG"), // health check fails
    });
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    const client = await initRedisClient({
      redisUrl: "redis://localhost:6379",
      loggerLayer: silentLogger,
    });

    expect(client).not.toBe(mockClient);
    expect(await client.ping()).toBe("PONG");
  });

  it("calls disconnect() on health check failure (P-W1)", async () => {
    const disconnectFn = mockFn(undefined);
    const mockClient = createMockConnectableClient({
      ping: mockFn("NOT_PONG"),
      disconnect: disconnectFn,
    });
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    await initRedisClient({
      redisUrl: "redis://localhost:6379",
      loggerLayer: silentLogger,
    });

    expect(disconnectFn).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // S-L1: REDIS_REQUIRED
  // -------------------------------------------------------------------------

  it("exits process when REDIS_REQUIRED is true and Redis fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const mockClient = createMockConnectableClient({
      connect: mockFnReject(new Error("ECONNREFUSED")),
    });
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    await expect(
      initRedisClient({
        redisUrl: "redis://localhost:6379",
        redisRequired: true,
        loggerLayer: silentLogger,
      }),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("does not exit when REDIS_REQUIRED is false and Redis fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const mockClient = createMockConnectableClient({
      connect: mockFnReject(new Error("ECONNREFUSED")),
    });
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    // Should NOT throw — falls back gracefully
    const client = await initRedisClient({
      redisUrl: "redis://localhost:6379",
      redisRequired: false,
      loggerLayer: silentLogger,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(await client.ping()).toBe("PONG");
    exitSpy.mockRestore();
  });
});
