import { Data } from "effect";

import { parseStage } from "./stage";
import { refuseProductionTier } from "./target";

/** Zones production serves from. A dev domain is never one of them or under one. */
export const PRODUCTION_ZONES: readonly string[] = [
  "cireweddings.com",
  "musubi.social",
  "pulse.events",
];

/** Shared suffixes whose hosts are `<script>.<subdomain>.<suffix>`, which this layout cannot use. */
const SHARED_SUFFIXES: readonly string[] = ["workers.dev", "pages.dev"];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The longest DNS name, in characters. */
const MAX_NAME = 253;

export class MissingDevDomainError extends Data.TaggedError("MissingDevDomainError")<{
  readonly message: string;
}> {}

export class InvalidDevDomainError extends Data.TaggedError("InvalidDevDomainError")<{
  readonly domain: string;
  readonly message: string;
}> {}

const under = (name: string, zone: string): boolean => name === zone || name.endsWith(`.${zone}`);

/** Returns `raw` when it is a bare lower-case domain the dev tier may serve from, and throws InvalidDevDomainError otherwise. */
export function parseDevDomain(raw: string): string {
  const labels = raw.split(".");
  if (raw.length > MAX_NAME || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new InvalidDevDomainError({
      domain: raw,
      message: `DEV_DOMAIN '${raw}' is not a bare lower-case domain name with at least two labels.`,
    });
  }
  if (PRODUCTION_ZONES.some((zone) => under(raw, zone))) {
    throw new InvalidDevDomainError({
      domain: raw,
      message: `DEV_DOMAIN '${raw}' is a production zone or a name under one.`,
    });
  }
  if (SHARED_SUFFIXES.some((suffix) => under(raw, suffix))) {
    throw new InvalidDevDomainError({
      domain: raw,
      message: `DEV_DOMAIN '${raw}' is under workers.dev or pages.dev, whose hosts cannot take the dev host layout; the dev tier needs a zone of its own.`,
    });
  }
  return raw;
}

/** The dev domain from `env.DEV_DOMAIN`, the dev GitHub Environment variable. */
export function readDevDomain(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.DEV_DOMAIN ?? "";
  if (raw === "") {
    throw new MissingDevDomainError({
      message:
        "DEV_DOMAIN is unset: set it as a variable on the dev GitHub Environment to the dev account's zone.",
    });
  }
  return parseDevDomain(raw);
}

/** Every host one stage serves, each derived from the dev domain. */
export interface StageHosts {
  /** The WebAuthn RP ID and osn-api's cookie domain. */
  readonly musubiSocial: string;
  /** osn-api, and so the OIDC issuer. */
  readonly osnApi: string;
  readonly musubiLanding: string;
  readonly cireLanding: string;
  readonly cireApi: string;
  readonly cireInvites: string;
  readonly cireHost: string;
  readonly cireVendor: string;
  readonly zapApi: string;
  readonly pulseLanding: string;
}

/**
 * The hosts a stage serves: under `domain` for `dev`, under
 * `<stage>.<domain>` for an investigation stage. The production tier is
 * refused; its hosts are today's production domains.
 */
export function stageHosts(domain: string, stage: string): StageHosts {
  const valid = parseStage(stage);
  refuseProductionTier(valid);
  const base = valid === "dev" ? parseDevDomain(domain) : `${valid}.${parseDevDomain(domain)}`;
  const hosts: StageHosts = {
    musubiSocial: `musubi.${base}`,
    osnApi: `id.musubi.${base}`,
    musubiLanding: `www.musubi.${base}`,
    cireLanding: `cire.${base}`,
    cireApi: `api.cire.${base}`,
    cireInvites: `invite.cire.${base}`,
    cireHost: `host.cire.${base}`,
    cireVendor: `vendor.cire.${base}`,
    zapApi: `zap.cire.${base}`,
    pulseLanding: `pulse.${base}`,
  };
  const tooLong = Object.values(hosts).find((host) => host.length > MAX_NAME);
  if (tooLong !== undefined) {
    throw new InvalidDevDomainError({
      domain,
      message: `The dev host '${tooLong}' is longer than ${MAX_NAME} characters.`,
    });
  }
  return hosts;
}

export const origin = (host: string): string => `https://${host}`;

const snakeCase = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The values the `dev-hosts` command writes, one GitHub step output each:
 * every host's origin as `<host_key>_origin`, then the URLs registered
 * outside the repository that name cire-api, built from its routes
 * (cire/api/src/index.ts OIDC callback, cire/api/src/routes/stripe-webhook.ts,
 * cire/api/src/routes/stripe-platform-webhook.ts).
 */
export function devHostOutputs(domain: string, stage: string): ReadonlyMap<string, string> {
  const hosts = stageHosts(domain, stage);
  const cireApi = origin(hosts.cireApi);
  return new Map([
    ...Object.entries(hosts).map(([key, host]): [string, string] => [
      `${snakeCase(key)}_origin`,
      origin(host),
    ]),
    ["oidc_redirect_uri", `${cireApi}/api/auth/oidc/callback`],
    ["stripe_webhook_url", `${cireApi}/api/stripe/webhook`],
    ["stripe_platform_webhook_url", `${cireApi}/api/stripe/platform-webhook`],
  ]);
}
