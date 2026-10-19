// The musubi stack job's cire_seed step runs scripts/derive-cire-seed.ts as
// the only step holding cire's OIDC client secret and ARC private key. These
// run it the way the step does — `bun --no-install`, from the repository root,
// writing to $GITHUB_OUTPUT — and check that what it writes is what osn-api's
// seed needs and that neither secret leaves it.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { origin, stageHosts } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { osnSeedSql } from "../../src/seeds";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = "musubi/infra/scripts/derive-cire-seed.ts";

const ARC_KEY_ID = "0b6f8f5e-2d1c-4c7a-9f3e-5a4b3c2d1e0f";
const CLIENT_SECRET = "cs_placeholder-client-secret";

interface PrivateJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** What the script wrote to $GITHUB_OUTPUT. */
  readonly output: string;
}

const dirs: string[] = [];
let privateJwk = "";
let parsedPrivate: PrivateJwk;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  parsedPrivate = JSON.parse(privateJwk) as PrivateJwk;
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The step's environment: the three secrets as deploy.yml passes them. */
const secrets = (): Record<string, string | undefined> => ({
  CIRE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  CIRE_API_ARC_KEY_ID: ARC_KEY_ID,
  CIRE_API_ARC_PRIVATE_KEY: privateJwk,
});

/** Runs the script as the cire_seed step runs it. */
function derive(env: Readonly<Record<string, string | undefined>>): Run {
  const dir = mkdtempSync(join(tmpdir(), "derive-cire-seed-"));
  dirs.push(dir);
  const output = join(dir, "output");
  writeFileSync(output, "");
  const defined = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const run = Bun.spawnSync(["bun", "--no-install", SCRIPT], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...defined },
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
    output: readFileSync(output, "utf8"),
  };
}

/** The `name=value` lines of a $GITHUB_OUTPUT file. */
const outputsOf = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

describe("derive-cire-seed", () => {
  test("DV2: writes the key id, the public JWK and the client secret's SHA-256, and nothing of either secret", async () => {
    const run = derive(secrets());
    expect(run.exitCode).toBe(0);

    const outputs = outputsOf(run.output);
    expect(Object.keys(outputs).toSorted()).toEqual([
      "client_secret_sha256",
      "key_id",
      "public_jwk",
    ]);
    expect(outputs.key_id).toBe(ARC_KEY_ID);

    // The hash osn-api's client-secret check computes.
    const oidc = readFileSync(join(repoRoot, "osn/api/src/services/auth/oidc.ts"), "utf8");
    expect(oidc).toContain(
      'const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");',
    );
    expect(oidc).toMatch(
      /export function hashClientSecret\(secret: string\): string \{\s*return sha256Hex\(secret\);\s*\}/,
    );
    expect(outputs.client_secret_sha256).toBe(
      createHash("sha256").update(CLIENT_SECRET).digest("hex"),
    );

    // The key's public half: kty, crv, x and y, importable as an ES256 key.
    const jwk = JSON.parse(outputs.public_jwk ?? "null") as Record<string, string>;
    expect(jwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: parsedPrivate.x,
      y: parsedPrivate.y,
    });
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(key.type).toBe("public");

    // The step prints nothing, and no output carries either secret.
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(run.output).not.toContain(CLIENT_SECRET);
    expect(run.output).not.toContain(parsedPrivate.d);
    expect(run.output).not.toContain('"d"');
  });

  test.each(["CIRE_OIDC_CLIENT_SECRET", "CIRE_API_ARC_KEY_ID", "CIRE_API_ARC_PRIVATE_KEY"])(
    "DV3: %s unset, blank or padded stops the step, naming it and never its value, and writes nothing",
    (name) => {
      for (const value of [undefined, "", "   ", ` ${name}-padded-value `]) {
        const run = derive({ ...secrets(), [name]: value });
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain(name);
        expect(run.stderr).not.toContain(`${name}-padded-value`);
        expect(run.stdout).toBe("");
        expect(run.output).toBe("");
      }
    },
  );

  test("DV4: a key id that is not a UUID, or a key that is not EC P-256 with x and y, stops the step and writes nothing", () => {
    const refused: [string, string][] = [
      ["CIRE_API_ARC_KEY_ID", "not-a-uuid"],
      // A line break would start an output of its own in $GITHUB_OUTPUT.
      ["CIRE_API_ARC_KEY_ID", `${ARC_KEY_ID}\npublic_jwk=forged`],
      ["CIRE_API_ARC_KEY_ID", `${ARC_KEY_ID}'`],
      ["CIRE_API_ARC_PRIVATE_KEY", "secret-material-not-json"],
      ["CIRE_API_ARC_PRIVATE_KEY", "[]"],
      ["CIRE_API_ARC_PRIVATE_KEY", JSON.stringify({ ...parsedPrivate, kty: "RSA" })],
      ["CIRE_API_ARC_PRIVATE_KEY", JSON.stringify({ ...parsedPrivate, crv: "P-384" })],
      ["CIRE_API_ARC_PRIVATE_KEY", JSON.stringify({ kty: "EC", crv: "P-256", x: parsedPrivate.x })],
      ["CIRE_API_ARC_PRIVATE_KEY", JSON.stringify({ ...parsedPrivate, x: `${parsedPrivate.x}'` })],
    ];
    for (const [name, value] of refused) {
      const run = derive({ ...secrets(), [name]: value });
      expect({ name, value, exitCode: run.exitCode }).toEqual({ name, value, exitCode: 1 });
      expect(run.stderr).toContain(name);
      expect(run.stderr).not.toMatch(new RegExp(`${parsedPrivate.d}|secret-material|forged`));
      expect(run.output).toBe("");
    }
  });

  test("DV5: osn-api's seed takes what the step writes, and carries the public key and the hash verbatim", () => {
    const outputs = outputsOf(derive(secrets()).output);
    const sql = osnSeedSql({
      cireApiOrigin: origin(stageHosts("example.test", "dev").cireApi),
      clientSecretSha256: outputs.client_secret_sha256 ?? "",
      arcKeyId: outputs.key_id ?? "",
      arcPublicJwk: outputs.public_jwk ?? "",
    });
    expect(sql).toContain(`'${outputs.public_jwk}'`);
    expect(sql).toContain(`'${outputs.client_secret_sha256}'`);
    expect(sql).toContain(`'${ARC_KEY_ID}'`);
  });
});
