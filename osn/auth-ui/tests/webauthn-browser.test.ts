import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const valuesOf = (source: BufferSource) =>
  Array.from(
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
  );

afterEach(() => vi.unstubAllGlobals());

describe("WebAuthn browser ceremony", () => {
  it("passes decoded registration options to the credential API and serializes the response", async () => {
    const create = vi.fn(async (_options: CredentialCreationOptions) => ({
      id: "credential-id",
      rawId: bytes(1, 2, 3),
      type: "public-key",
      response: {
        attestationObject: bytes(4, 5),
        clientDataJSON: bytes(6, 7),
        getTransports: () => ["internal"],
      },
      getClientExtensionResults: () => ({}),
      authenticatorAttachment: "platform",
    }));
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", { credentials: { create } });

    const result = await startRegistration({
      optionsJSON: {
        challenge: "AQID",
        rp: { name: "OSN", id: "example.com" },
        user: { id: "BAUG", name: "alice", displayName: "Alice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      },
    });

    expect(create).toHaveBeenCalledOnce();
    const options = create.mock.calls[0]![0];
    expect(valuesOf(options.publicKey!.challenge)).toEqual([1, 2, 3]);
    expect(valuesOf(options.publicKey!.user.id)).toEqual([4, 5, 6]);
    expect(result).toMatchObject({
      id: "credential-id",
      rawId: "AQID",
      response: { attestationObject: "BAU", clientDataJSON: "Bgc", transports: ["internal"] },
      authenticatorAttachment: "platform",
    });
  });

  it("supports explicit authentication and conditional autofill with the real browser library", async () => {
    const get = vi.fn(async (_options: CredentialRequestOptions) => ({
      id: "credential-id",
      rawId: bytes(1, 2, 3),
      type: "public-key",
      response: {
        authenticatorData: bytes(4),
        clientDataJSON: bytes(5),
        signature: bytes(6),
        userHandle: bytes(7),
      },
      getClientExtensionResults: () => ({}),
      authenticatorAttachment: "platform",
    }));
    vi.stubGlobal(
      "PublicKeyCredential",
      Object.assign(function PublicKeyCredential() {}, {
        isConditionalMediationAvailable: async () => true,
      }),
    );
    vi.stubGlobal("navigator", { credentials: { get } });
    vi.stubGlobal("document", { querySelectorAll: () => [{}] });

    const optionsJSON = {
      challenge: "BAUG",
      allowCredentials: [{ id: "AQID", type: "public-key" as const }],
    };
    const result = await startAuthentication({ optionsJSON });
    expect(get).toHaveBeenCalledOnce();
    const options = get.mock.calls[0]![0];
    expect(valuesOf(options.publicKey!.challenge)).toEqual([4, 5, 6]);
    expect(valuesOf(options.publicKey!.allowCredentials![0]!.id)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      rawId: "AQID",
      response: {
        authenticatorData: "BA",
        clientDataJSON: "BQ",
        signature: "Bg",
        userHandle: "Bw",
      },
    });

    await startAuthentication({ optionsJSON, useBrowserAutofill: true });
    const autofill = get.mock.calls[1]![0];
    expect(autofill).toMatchObject({
      mediation: "conditional",
      publicKey: { allowCredentials: [] },
    });
  });
});
