import { describe, expect, it } from "vitest";

import { buildDevEnv, DEV_ENV, resolveSelfId } from "../src/app-env";
import { DEV_APPS, type DevAppId } from "../src/index";

/** A portless URL for `app`, with an optional worktree prefix. */
const urlFor = (app: DevAppId, prefix = "") => ({
  PORTLESS_URL: `https://${prefix}${DEV_APPS[app].name}.localhost`,
});

describe("buildDevEnv", () => {
  it("is empty without portless, so every app keeps its fixed-port defaults", () => {
    expect(buildDevEnv("@osn/api", {})).toEqual({});
    expect(buildDevEnv("@cire/host", {})).toEqual({});
  });

  it("gives @osn/api its issuer, RP ID and both origin lists", () => {
    expect(buildDevEnv("@osn/api", urlFor("@osn/api"))).toEqual({
      OSN_ISSUER_URL: "https://id.musubi.localhost",
      OSN_RP_ID: "musubi.localhost",
      OSN_ORIGIN:
        "https://musubi.localhost,https://pulse.localhost,https://invite.cire.localhost,https://host.cire.localhost,https://vendor.cire.localhost",
      OSN_CORS_ORIGIN:
        "https://musubi.localhost,https://pulse.localhost,https://invite.cire.localhost,https://host.cire.localhost,https://vendor.cire.localhost",
      DEV_LOGIN_RETURN_ORIGINS:
        "https://musubi.localhost,https://host.cire.localhost,https://vendor.cire.localhost,https://invite.cire.localhost",
      PULSE_API_URL: "https://api.pulse.localhost",
      ZAP_API_URL: "https://zap.cire.localhost",
    });
  });

  it("gives @cire/api the three guest/organiser origins and the JWKS path", () => {
    expect(buildDevEnv("@cire/api", urlFor("@cire/api"))).toEqual({
      WEB_ORIGIN:
        "https://invite.cire.localhost,https://host.cire.localhost,https://vendor.cire.localhost",
      OSN_ISSUER_URL: "https://id.musubi.localhost",
      OSN_JWKS_URL: "https://id.musubi.localhost/.well-known/jwks.json",
      CIRE_API_ORIGIN: "https://api.cire.localhost",
      ZAP_API_URL: "https://zap.cire.localhost",
    });
  });

  it("gives @pulse/api the S2S URL as well as the issuer", () => {
    // `OSN_API_URL` is a separate var from `OSN_ISSUER_URL`: osn-bridge and
    // outbound-arc call osn-api server-to-server through it.
    expect(buildDevEnv("@pulse/api", urlFor("@pulse/api"))).toEqual({
      OSN_ISSUER_URL: "https://id.musubi.localhost",
      OSN_JWKS_URL: "https://id.musubi.localhost/.well-known/jwks.json",
      OSN_API_URL: "https://id.musubi.localhost",
      PULSE_API_ORIGIN: "https://api.pulse.localhost",
      PULSE_CORS_ORIGIN: "https://pulse.localhost",
      PULSE_LOGIN_URL: "https://pulse.localhost/",
    });
  });

  it("gives @zap/api its CORS allowlist, S2S URL and token verification", () => {
    expect(buildDevEnv("@zap/api", urlFor("@zap/api"))).toEqual({
      OSN_API_URL: "https://id.musubi.localhost",
      // Both halves of access-token verification. Without them zap kept its
      // `http://localhost:4000` defaults while osn-api minted under the
      // portless host, so every bearer-authenticated route 401'd.
      OSN_ISSUER_URL: "https://id.musubi.localhost",
      OSN_JWKS_URL: "https://id.musubi.localhost/.well-known/jwks.json",
      ZAP_CORS_ORIGIN: "https://pulse.localhost,https://musubi.localhost",
    });
  });

  it("gives each frontend the siblings it fetches", () => {
    expect(buildDevEnv("@cire/host", urlFor("@cire/host"))).toEqual({
      PUBLIC_API_URL: "https://api.cire.localhost",
      PUBLIC_CIRE_API_URL: "https://api.cire.localhost",
      PUBLIC_CIRE_WEB_URL: "https://invite.cire.localhost",
      PUBLIC_OSN_ACCOUNT_URL: "https://musubi.localhost",
    });
    expect(buildDevEnv("@pulse/web", urlFor("@pulse/web"))).toEqual({
      VITE_API_URL: "https://api.pulse.localhost",
      VITE_OSN_ISSUER_URL: "https://id.musubi.localhost",
    });
  });

  it("carries the worktree prefix into every derived var", () => {
    const env = buildDevEnv("@cire/api", urlFor("@cire/api", "my-branch."));
    expect(env.WEB_ORIGIN).toBe(
      "https://my-branch.invite.cire.localhost,https://my-branch.host.cire.localhost,https://my-branch.vendor.cire.localhost",
    );
    expect(env.OSN_JWKS_URL).toBe("https://my-branch.id.musubi.localhost/.well-known/jwks.json");
  });

  it("keeps the RP ID free of the worktree prefix, so one covers every worktree", () => {
    // It has to stay a suffix of both musubi.* and id.musubi.*, prefixed or not.
    expect(buildDevEnv("@osn/api", urlFor("@osn/api", "my-branch.")).OSN_RP_ID).toBe(
      "musubi.localhost",
    );
  });

  it("covers every app in DEV_APPS", () => {
    expect(Object.keys(DEV_ENV).toSorted()).toEqual(Object.keys(DEV_APPS).toSorted());
  });

  it("derives only absolute http(s) origins", () => {
    for (const id of Object.keys(DEV_APPS) as DevAppId[]) {
      for (const [key, value] of Object.entries(buildDevEnv(id, urlFor(id)))) {
        if (key === "OSN_RP_ID") continue;
        for (const origin of value.split(",")) {
          expect(origin).toMatch(/^https?:\/\/[^,\s]+$/);
        }
      }
    }
  });

  it("gives @cire/api a WEB_ORIGIN its Workers entry will accept", () => {
    // cire/api/src/index.ts 503s the whole Worker unless every entry is
    // https:// or http://localhost. Portless serves TLS, so this holds — but
    // the assertion is here because that guard lives in another package.
    const origins = buildDevEnv("@cire/api", urlFor("@cire/api")).WEB_ORIGIN!.split(",");
    for (const origin of origins) {
      expect(origin.startsWith("https://") || origin.startsWith("http://localhost")).toBe(true);
    }
  });
});

describe("resolveSelfId", () => {
  it("accepts every workspace package it knows", () => {
    for (const id of Object.keys(DEV_APPS)) {
      expect(resolveSelfId(id)).toBe(id);
    }
  });

  it("throws with a message naming where to add an unknown package", () => {
    expect(() => resolveSelfId("@osn/nope")).toThrow(/not in DEV_APPS/);
    expect(() => resolveSelfId(undefined)).toThrow(/not in DEV_APPS/);
  });
});
