import { Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initRedisClient } from "../src/redis";

// Mock @shared/redis so no real ioredis connection is attempted.
vi.mock("@shared/redis", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createClientFromUrl: vi.fn(),
  };
});

import {
  createClientFromUrl,
  createMemoryClient,
  type ConnectableRedisClient,
} from "@shared/redis";

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

describe("pulse initRedisClient — backend selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the in-memory client when REDIS_URL is unset (local/test)", async () => {
    const client = await initRedisClient({ redisUrl: undefined, loggerLayer: silentLogger });
    expect(await client.ping()).toBe("PONG");
    expect(mockedCreateClientFromUrl).not.toHaveBeenCalled();
  });

  it("uses the Redis client when REDIS_URL is set and healthy", async () => {
    const mockClient = createMockConnectableClient();
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    const client = await initRedisClient({
      redisUrl: "redis://localhost:6379",
      loggerLayer: silentLogger,
    });

    expect(mockedCreateClientFromUrl).toHaveBeenCalledWith("redis://localhost:6379");
    expect(client).toBe(mockClient);
  });

  it("falls back to in-memory when the Redis connection fails", async () => {
    const mockClient = createMockConnectableClient({
      connect: mockFnReject(new Error("ECONNREFUSED")),
    });
    mockedCreateClientFromUrl.mockReturnValue(mockClient);

    const client = await initRedisClient({
      redisUrl: "redis://localhost:6379",
      loggerLayer: silentLogger,
    });

    expect(client).not.toBe(mockClient);
    expect(await client.ping()).toBe("PONG");
  });

  it("exits the process when REDIS_REQUIRED is set and Redis fails (S-L1)", async () => {
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
});
