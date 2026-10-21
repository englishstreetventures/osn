import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { origin, stageHosts } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { musubiDeclaration } from "../../../musubi/infra/src/declaration";
import { osnSeedSql } from "../../../musubi/infra/src/seeds";
import { cireDeclaration } from "../src/declaration";

const cireApiOidc = readFileSync(
  fileURLToPath(new URL("../../api/src/lib/oidc.ts", import.meta.url)),
  "utf8",
);

describe("the cire and musubi stacks together", () => {
  test("S2: osn-api's seeded redirect URI, dev-login origins and issuer are the ones cire-api's vars name", async () => {
    for (const stage of ["dev", "probe"]) {
      const hosts = stageHosts("example.test", stage);
      const cire = cireDeclaration({ stage, hosts, generatedDir: ".generated", ownerSeat: false })
        .cireApi.vars;
      const osnApi = musubiDeclaration({ stage, hosts, generatedDir: ".generated" }).osnApi.vars;

      // The musubi stack seeds the OIDC client from the cire-api origin it
      // derives from the same hosts (musubi/infra/alchemy.run.ts).
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const seed = osnSeedSql({
        cireApiOrigin: origin(hosts.cireApi),
        // SHA-256("abc"): a hash of the shape the cire_seed step writes.
        clientSecretSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        arcKeyId: "0b6f8f5e-2d1c-4c7a-9f3e-5a4b3c2d1e0f",
        arcPublicJwk: JSON.stringify({ kty, crv, x, y }),
      });
      const redirectUris = /VALUES \('oc_cire', 'cid_cire', 'Cire', NULL, '(\[[^']*\])'/.exec(
        seed,
      )?.[1];
      // cire-api builds its redirect URI from CIRE_API_ORIGIN this way.
      expect(cireApiOidc).toContain("redirectUri: `${apiOrigin}/api/auth/oidc/callback`");
      expect(JSON.parse(redirectUris ?? "null")).toEqual([
        `${cire.CIRE_API_ORIGIN}/api/auth/oidc/callback`,
      ]);

      // dev-login returns only to musubi social and the three cire sites
      // cire-api serves to browsers.
      const devLoginOrigins = (osnApi.DEV_LOGIN_RETURN_ORIGINS ?? "").split(",");
      const webOrigins = (cire.WEB_ORIGIN ?? "").split(",");
      expect(webOrigins).toHaveLength(3);
      expect(devLoginOrigins.filter((entry) => entry !== osnApi.OSN_ORIGIN).toSorted()).toEqual(
        webOrigins.toSorted(),
      );

      expect(cire.OSN_ISSUER_URL).toBe(osnApi.OSN_ISSUER_URL);
      expect(cire.OSN_JWKS_URL).toBe(`${osnApi.OSN_ISSUER_URL}/.well-known/jwks.json`);
      expect(cire.OSN_API_URL).toBe(osnApi.OSN_ISSUER_URL);
    }
  });
});
