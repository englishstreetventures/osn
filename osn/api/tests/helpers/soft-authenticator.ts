/**
 * A software authenticator for the route and service tests: it answers
 * `/passkey/register/begin`'s options with a real `fmt: "none"` attestation
 * for a fresh P-256 key, which `@simplewebauthn/server` verifies like any
 * browser's. A `none` attestation carries no signature, so no private key is
 * used; the key pair exists only to give the credential a real public key.
 *
 * Tests that need an account with a passkey enrol one through the routes with
 * this, rather than writing a `passkeys` row into the store.
 */

import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/** User present, user verified, attested credential data included. */
const FLAGS_UP_UV_AT = 0x45;

/** The parts of `PublicKeyCredentialCreationOptionsJSON` the attestation answers. */
export interface CreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
}

/** The `RegistrationResponseJSON` `/passkey/register/complete` takes. */
export interface NoneAttestation {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly clientExtensionResults: Record<string, never>;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports: string[];
  };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A `none` attestation of a new credential for `options`, as a browser at
 * `origin` (the first, when the config lists several) would answer it.
 * `rpId` stands in when the options name none.
 */
export async function noneAttestation(
  options: CreationOptions,
  origin: string | readonly string[],
  rpId = "localhost",
): Promise<NoneAttestation> {
  const from = typeof origin === "string" ? origin : origin[0]!;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  // COSE_Key, EC2: kty 2, alg -7 (ES256), crv 1 (P-256), x, y.
  const coseKey = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, raw.slice(1, 33)],
    [-3, raw.slice(33, 65)],
  ]);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rp.id ?? rpId)),
  );
  const authData = concat(
    rpIdHash,
    new Uint8Array([FLAGS_UP_UV_AT]),
    new Uint8Array(4), // signature counter
    new Uint8Array(16), // AAGUID
    new Uint8Array([0, credentialId.length]),
    credentialId,
    isoCBOR.encode(coseKey),
  );
  const attestationObject = isoCBOR.encode(
    new Map<string, string | Map<string, string> | Uint8Array>([
      ["fmt", "none"],
      ["attStmt", new Map<string, string>()],
      ["authData", authData],
    ]),
  );
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: from,
      crossOrigin: false,
    }),
  );
  const id = isoBase64URL.fromBuffer(credentialId);
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal"],
    },
  };
}
