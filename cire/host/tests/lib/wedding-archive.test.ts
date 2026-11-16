import { AuthExpiredError } from "@shared/rp-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});
const saved = vi.fn<(name: string, blob: Blob) => void>();
vi.mock("../../src/lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => saved(name, blob),
}));

import {
  __resetWeddingArchives,
  formatBytes,
  startWeddingArchive,
  weddingArchiveState,
} from "../../src/lib/wedding-archive";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

/**
 * The whole-wedding download, one test per way it can go wrong. The happy path
 * through the real API is the `cire-seating` E2E flow; what it cannot steer
 * into — a stream cut part way, each refusal, a dropped connection, a second
 * press — is here.
 *
 *  1. A whole archive is saved as `cire-wedding-<slug>.zip`, every byte as received.
 *  2. A body that stops before the ZIP's end record saves nothing, even where
 *     its last bytes open with another ZIP record's signature.
 *  3. A body shorter than the end record (an empty one) saves nothing, even
 *     where it starts with the end record's signature.
 *  4. An end record with bytes after it is not the end: nothing saved.
 *  5. A stream that errors part way saves nothing.
 *  6. A 401 sends the owner to sign in, saves nothing and leaves no failure.
 *  7. 403, 404, 429 and 500 each fail with their own reason.
 *  8. A 429 is asked once: no automatic retry.
 *  9. A request that never reaches the API fails as a connection problem.
 * 10. While it runs, the state carries the running total of bytes received.
 * 11. A second start while one runs sends no second request.
 * 12. A finished download, failed or saved, can be started again.
 * 13. A size reads in KB under a megabyte, never "0 KB" or "1000 KB", else MB,
 *     and its number never wraps away from its unit.
 */

const SLUG = "aisha-and-ben-1a2b3c";
const WEDDING = "wed_1";

/** An empty ZIP: the end-of-central-directory record alone, no comment. */
const END_RECORD = Uint8Array.from([
  0x50,
  0x4b,
  0x05,
  0x06,
  ...Array.from({ length: 18 }, () => 0),
]);
/** Some archive bytes before the end record. */
const BODY = Uint8Array.from({ length: 40 }, (_, i) => (i * 7) % 251);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A 200 whose body arrives in `chunks`, then ends, or errors when `fail` is set. */
function zipResponse(chunks: Uint8Array[], fail?: Error): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (fail) controller.error(fail);
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/zip" } });
}

const statusResponse = (status: number) =>
  new Response(JSON.stringify({ error: "x" }), {
    status,
    headers: { "content-type": "application/json" },
  });

const state = () => weddingArchiveState(WEDDING)();
const start = () => startWeddingArchive(authFetchMock, WEDDING, SLUG);

async function savedBytes(): Promise<Uint8Array> {
  const [, blob] = saved.mock.calls[0]!;
  return new Uint8Array(await blob.arrayBuffer());
}

afterEach(() => {
  resetOrganiserMocks();
  saved.mockReset();
  __resetWeddingArchives();
});

describe("startWeddingArchive", () => {
  it("1. saves a whole archive as cire-wedding-<slug>.zip, every byte as received", async () => {
    authFetchMock.mockResolvedValueOnce(
      zipResponse([BODY.slice(0, 13), BODY.slice(13), END_RECORD]),
    );
    await start();

    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]![0]).toBe(`cire-wedding-${SLUG}.zip`);
    expect(saved.mock.calls[0]![1].type).toBe("application/zip");
    expect(await savedBytes()).toEqual(concat(BODY, END_RECORD));
    expect(state()).toEqual({
      phase: "ready",
      fileName: `cire-wedding-${SLUG}.zip`,
      size: BODY.byteLength + END_RECORD.byteLength,
    });
  });

  it("2. saves nothing when the body stops before the end record", async () => {
    const whole = concat(BODY, END_RECORD);
    authFetchMock.mockResolvedValueOnce(zipResponse([whole.slice(0, whole.byteLength - 5)]));
    await start();
    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });

    // Cut inside a file entry: 22 bytes from the end sits a local file
    // header, `PK 03 04`, which shares the end record's first two bytes.
    const entryHeader = Uint8Array.from([
      0x50,
      0x4b,
      0x03,
      0x04,
      ...Array.from({ length: 18 }, () => 1),
    ]);
    authFetchMock.mockResolvedValueOnce(zipResponse([BODY, entryHeader]));
    await start();
    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });
  });

  it("3. saves nothing when the body is shorter than the end record", async () => {
    authFetchMock.mockResolvedValueOnce(zipResponse([END_RECORD.slice(0, 21)]));
    await start();
    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });

    authFetchMock.mockResolvedValueOnce(zipResponse([]));
    await start();
    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });

    authFetchMock.mockResolvedValueOnce(zipResponse([END_RECORD.slice(0, 11)]));
    await start();
    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });
  });

  it("4. saves nothing when bytes follow the end record", async () => {
    authFetchMock.mockResolvedValueOnce(zipResponse([BODY, END_RECORD, Uint8Array.of(0)]));
    await start();

    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });
  });

  it("5. saves nothing when the stream errors part way", async () => {
    authFetchMock.mockResolvedValueOnce(zipResponse([BODY, END_RECORD], new Error("reset")));
    await start();

    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "cut" });
  });

  it("6. sends a signed-out owner to sign in, saving nothing and showing no failure", async () => {
    authFetchMock.mockRejectedValueOnce(new AuthExpiredError());
    await start();

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "idle" });
  });

  it.each([
    [403, "forbidden"],
    [404, "notFound"],
    [429, "limit"],
    [500, "server"],
  ] as const)("7. fails a %i as %s, saving nothing", async (status, reason) => {
    authFetchMock.mockResolvedValueOnce(statusResponse(status));
    await start();

    expect(saved).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason });
  });

  it("8. asks once on a 429, with no automatic retry", async () => {
    authFetchMock.mockResolvedValue(statusResponse(429));
    await start();

    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("9. fails as a connection problem when the request never reaches the API", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await start();

    expect(redirectSpy).not.toHaveBeenCalled();
    expect(state()).toEqual({ phase: "failed", reason: "network" });
  });

  it("10. carries the running total of bytes received while it runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(BODY.slice(0, 10));
        await gate;
        controller.enqueue(BODY.slice(10));
        controller.enqueue(END_RECORD);
        controller.close();
      },
    });
    authFetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const running = start();
    expect(state()).toEqual({ phase: "preparing", received: 0 });
    await vi.waitFor(() => expect(state()).toEqual({ phase: "preparing", received: 10 }));
    release();
    await running;

    expect(state()).toMatchObject({ phase: "ready", size: 62 });
  });

  it("11. sends no second request while one is running", async () => {
    let answer: (res: Response) => void = () => {};
    authFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));

    const first = start();
    await start();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    answer(zipResponse([END_RECORD]));
    await first;
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("12. starts again after a failure, and after a saved download", async () => {
    authFetchMock.mockResolvedValueOnce(statusResponse(500));
    await start();
    expect(state()).toEqual({ phase: "failed", reason: "server" });

    authFetchMock.mockResolvedValueOnce(zipResponse([END_RECORD]));
    await start();
    expect(state()).toMatchObject({ phase: "ready" });

    authFetchMock.mockResolvedValueOnce(zipResponse([END_RECORD]));
    await start();
    expect(authFetchMock).toHaveBeenCalledTimes(3);
    expect(saved).toHaveBeenCalledTimes(2);
  });
});

describe("formatBytes", () => {
  it("13. reads in KB under a megabyte, never 0 KB or 1000 KB, in MB above, never wrapped", () => {
    // A no-break space between the number and its unit.
    expect(formatBytes(1)).toBe("1\u00a0KB");
    expect(formatBytes(999_499)).toBe("999\u00a0KB");
    expect(formatBytes(999_500)).toBe("1.0\u00a0MB");
    expect(formatBytes(4_200_000)).toBe("4.2\u00a0MB");
  });
});
