import { describe, it, expect } from "bun:test";

import { Effect } from "effect";

import {
  AssetsR2Service,
  createAssetsStub,
  deleteAsset,
  detectImageType,
  fetchAsset,
  storeAsset,
} from "./invite-assets";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("detectImageType", () => {
  it("recognises PNG, JPEG and WebP from magic bytes", () => {
    expect(detectImageType(buf(PNG))).toBe("image/png");
    expect(detectImageType(buf(JPEG))).toBe("image/jpeg");
    expect(detectImageType(buf(WEBP))).toBe("image/webp");
  });

  it("rejects a disallowed format (GIF) and obvious non-images", () => {
    expect(detectImageType(buf(GIF))).toBeNull();
    expect(detectImageType(buf(new Uint8Array([0x3c, 0x73, 0x76, 0x67])))).toBeNull(); // "<svg"
    expect(detectImageType(new ArrayBuffer(0))).toBeNull();
  });
});

describe("invite-assets R2 round-trip", () => {
  it("stores, fetches and deletes an image preserving content type", async () => {
    const stub = createAssetsStub();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* storeAsset("wed_x", "hero", buf(PNG), "image/png");
        const fetched = yield* fetchAsset(key);
        yield* deleteAsset(key);
        return { key, fetched };
      }).pipe(Effect.provideService(AssetsR2Service, stub)),
    );

    expect(result.key).toContain("assets/wed_x/hero-");
    expect(result.fetched.contentType).toBe("image/png");
    expect(new Uint8Array(result.fetched.bytes)).toEqual(PNG);
    expect(stub._store.size).toBe(0);
  });

  it("fails fetchAsset for a missing key", async () => {
    const stub = createAssetsStub();
    const exit = await Effect.runPromiseExit(
      fetchAsset("assets/missing").pipe(Effect.provideService(AssetsR2Service, stub)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
