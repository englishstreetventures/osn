/**
 * The ceremony options this service hands to a browser or the iOS client,
 * typed the way the wire schema (`routes/auth/response-schemas.ts`) declares
 * them.
 *
 * `@simplewebauthn/server` types a credential descriptor's `type` as a plain
 * `string`, though `generateAuthenticationOptions` and
 * `generateRegistrationOptions` always write `"public-key"` — the only value
 * WebAuthn defines. The wire schema keeps the literal, so the generated
 * OpenAPI and the Swift client see one value rather than any string. These
 * helpers set it explicitly, which makes the literal true by construction
 * instead of by cast.
 */

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

export type CredentialDescriptor = Omit<PublicKeyCredentialDescriptorJSON, "type"> & {
  type: "public-key";
};

export type RequestOptions = Omit<PublicKeyCredentialRequestOptionsJSON, "allowCredentials"> & {
  allowCredentials?: CredentialDescriptor[];
};

export type CreationOptions = Omit<PublicKeyCredentialCreationOptionsJSON, "excludeCredentials"> & {
  excludeCredentials?: CredentialDescriptor[];
};

const toDescriptors = (list: PublicKeyCredentialDescriptorJSON[]): CredentialDescriptor[] =>
  list.map((c) => ({ ...c, type: "public-key" }));

export const requestOptions = ({
  allowCredentials,
  ...rest
}: PublicKeyCredentialRequestOptionsJSON): RequestOptions =>
  allowCredentials ? { ...rest, allowCredentials: toDescriptors(allowCredentials) } : rest;

export const creationOptions = ({
  excludeCredentials,
  ...rest
}: PublicKeyCredentialCreationOptionsJSON): CreationOptions =>
  excludeCredentials ? { ...rest, excludeCredentials: toDescriptors(excludeCredentials) } : rest;

/** The transports a passkey row stored at registration, as the library takes them. */
export const storedTransports = (json: string | null): string[] | undefined =>
  json ? (JSON.parse(json) as string[]) : undefined;
