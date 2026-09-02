import { describe, expect, it } from "bun:test";

import { Effect, Exit } from "effect";

import {
  AssetsR2Service,
  createAssetsStub,
  MAX_IMAGE_BYTES,
} from "../../src/services/invite-assets";
import type { LinkPreviewOptions } from "../../src/services/link-preview";
import { registryImageService } from "../../src/services/registry-image";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const HTML = new TextEncoder().encode("<!doctype html><title>not an image</title>");

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Both seams injected — nothing in this file touches a network or a DNS server. */
function options(
  body: BodyInit,
  init: ResponseInit = { status: 200, headers: { "content-type": "image/png" } },
  addresses = ["93.184.216.34"],
): LinkPreviewOptions {
  return {
    fetchImpl: (() => Promise.resolve(new Response(body, init))) as unknown as typeof fetch,
    resolveHost: () => Promise.resolve(addresses),
  };
}

function runUpload(bytes: ArrayBuffer, declared?: string, stub = createAssetsStub()) {
  return Effect.runPromiseExit(
    registryImageService
      .storeUpload("wed_x", bytes, declared)
      .pipe(Effect.provideService(AssetsR2Service, stub)),
  );
}

function runFromUrl(url: string, opts: LinkPreviewOptions, stub = createAssetsStub()) {
  return Effect.runPromiseExit(
    registryImageService
      .storeFromUrl("wed_x", url, opts)
      .pipe(Effect.provideService(AssetsR2Service, stub)),
  );
}

/** The tag of the failure an exit carries, or `null` if it succeeded. */
function failureTag(exit: Exit.Exit<unknown, { readonly _tag: string }>): string | null {
  if (!Exit.isFailure(exit)) return null;
  return exit.cause._tag === "Fail" ? exit.cause.error._tag : exit.cause._tag;
}

describe("registryImageService.storeUpload", () => {
  it("stores each allowed format under the wedding's own prefix", async () => {
    for (const [bytes, type] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ] as const) {
      const stub = createAssetsStub();
      const exit = await runUpload(buf(bytes), "application/octet-stream", stub);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) continue;
      expect(exit.value.contentType).toBe(type);
      expect(exit.value.imageKey).toStartWith("assets/wed_x/registry-");
      // The bytes really landed, under the SNIFFED type — not the declared one.
      expect(stub._store.get(exit.value.imageKey)?.contentType).toBe(type);
    }
  });

  it("rejects a disallowed format on its signature, whatever the caller declares", async () => {
    // GIF is a real image and still refused: `detectImageType`'s return type IS
    // the allowlist, so there is no second list to drift out of step.
    expect(failureTag(await runUpload(buf(GIF), "image/png"))).toBe("RegistryImageUnsupportedType");
    // A lying Content-Type on HTML — the case that matters, because trusting the
    // header would put an XSS-capable document in an image slot.
    expect(failureTag(await runUpload(buf(HTML), "image/png"))).toBe(
      "RegistryImageUnsupportedType",
    );
  });

  it("rejects a body over the cap even though the route already checked the header", async () => {
    // `Content-Length` is a claim by the same client sending the body, so the
    // real length is re-checked here.
    const oversize = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversize.set(PNG, 0);
    const stub = createAssetsStub();
    expect(failureTag(await runUpload(buf(oversize), "image/png", stub))).toBe(
      "RegistryImageTooLarge",
    );
    expect(stub._store.size).toBe(0);
  });
});

describe("registryImageService.storeFromUrl", () => {
  it("copies the bytes into R2 and answers with a key, never the url", async () => {
    const stub = createAssetsStub();
    const exit = await runFromUrl("https://cdn.example/pan.jpg", options(buf(JPEG)), stub);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.imageKey).toStartWith("assets/wed_x/registry-");
    expect(exit.value.contentType).toBe("image/jpeg");
    expect(stub._store.size).toBe(1);
    // Nothing we hand back carries the third-party origin.
    expect(JSON.stringify(exit.value)).not.toContain("cdn.example");
  });

  it("re-runs the SSRF guard: a host resolving inward is blocked", async () => {
    // The URL came from OUR preview a moment ago and is still not trusted — it
    // arrived in a client-controlled request body.
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "100.64.0.1", "::1"]) {
      const stub = createAssetsStub();
      const exit = await runFromUrl(
        "https://rebind.example/pan.jpg",
        options(buf(PNG), { status: 200, headers: { "content-type": "image/png" } }, [address]),
        stub,
      );
      expect(failureTag(exit)).toBe("RegistryImageBlocked");
      expect(stub._store.size).toBe(0);
    }
  });

  it("blocks a non-https url without fetching", async () => {
    let fetched = 0;
    const exit = await runFromUrl("http://cdn.example/pan.jpg", {
      fetchImpl: (() => {
        fetched += 1;
        return Promise.resolve(new Response(buf(PNG)));
      }) as unknown as typeof fetch,
      resolveHost: () => Promise.resolve(["93.184.216.34"]),
    });
    expect(failureTag(exit)).toBe("RegistryImageBlocked");
    expect(fetched).toBe(0);
  });

  it("rejects a url that passes the guard but serves a document, not an image", async () => {
    // The decisive check is the SIGNATURE. This response lies twice — a 200 and
    // an `image/png` header over HTML.
    const stub = createAssetsStub();
    const exit = await runFromUrl(
      "https://cdn.example/pan.jpg",
      options(buf(HTML), { status: 200, headers: { "content-type": "image/png" } }),
      stub,
    );
    expect(failureTag(exit)).toBe("RegistryImageUnsupportedType");
    expect(stub._store.size).toBe(0);
  });

  it("rejects an oversize remote body at the cap, mid-stream", async () => {
    const stub = createAssetsStub();
    const exit = await runFromUrl(
      "https://cdn.example/huge.png",
      {
        ...options(buf(new Uint8Array(2048))),
        maxBytes: 1024,
      },
      stub,
    );
    expect(failureTag(exit)).toBe("RegistryImageTooLarge");
    expect(stub._store.size).toBe(0);
  });

  it("502-shaped failure when the remote answers with a non-200", async () => {
    const exit = await runFromUrl(
      "https://cdn.example/gone.png",
      options("nope", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    expect(failureTag(exit)).toBe("RegistryImageFetchFailed");
  });

  it("re-checks the guard on a redirect hop, not just the first url", async () => {
    // The classic bypass: a public host that 302s to link-local. `Location` never
    // passes through the boundary schema, so the per-hop recheck is the only
    // thing standing between us and the metadata service.
    const hosts: Record<string, string> = {
      "cdn.example": "93.184.216.34",
      "metadata.example": "169.254.169.254",
    };
    const stub = createAssetsStub();
    const exit = await Effect.runPromiseExit(
      registryImageService
        .storeFromUrl("wed_x", "https://cdn.example/pan.jpg", {
          fetchImpl: ((input: string) =>
            Promise.resolve(
              input.includes("metadata.example")
                ? new Response(buf(PNG), { status: 200 })
                : new Response("", {
                    status: 302,
                    headers: { location: "https://metadata.example/latest" },
                  }),
            )) as unknown as typeof fetch,
          resolveHost: (host: string) => Promise.resolve([hosts[host] ?? "93.184.216.34"]),
        })
        .pipe(Effect.provideService(AssetsR2Service, stub)),
    );
    expect(failureTag(exit)).toBe("RegistryImageBlocked");
    expect(stub._store.size).toBe(0);
  });
});
