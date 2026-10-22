import { describe, expect, test } from "vitest";

import {
  InvalidDevDomainError,
  MissingDevDomainError,
  parseDevDomain,
  readDevDomain,
  stageHosts,
} from "../src/hosts";
import { StageNotDeclaredError } from "../src/target";

describe("readDevDomain", () => {
  test("H1: an unset or empty DEV_DOMAIN is refused, naming the variable", () => {
    for (const env of [{}, { DEV_DOMAIN: "" }]) {
      expect(() => readDevDomain(env)).toThrow(MissingDevDomainError);
      expect(() => readDevDomain(env)).toThrow(/DEV_DOMAIN/);
    }
  });
});

describe("parseDevDomain", () => {
  test.each([
    " example.dev",
    "example.dev\n",
    "Example.dev",
    "https://example.dev",
    "example.dev/x",
    "example.dev:443",
    "example.dev.",
    "localhost",
    `${"a".repeat(64)}.dev`,
    `${"a.".repeat(127)}dev`,
  ])("H2: refuses %j", (raw) => {
    expect(() => parseDevDomain(raw)).toThrow(InvalidDevDomainError);
  });

  test.each([
    "cireweddings.com",
    "dev.cireweddings.com",
    "musubi.social",
    "x.musubi.social",
    "pulse.events",
  ])("H3: refuses the production zone %s and every name under one", (raw) => {
    expect(() => parseDevDomain(raw)).toThrow(InvalidDevDomainError);
    expect(() => parseDevDomain(raw)).toThrow(/production/);
  });

  test.each(["workers.dev", "acct.workers.dev", "pages.dev", "x.pages.dev"])(
    "H4: refuses %s, whose hosts cannot take this layout",
    (raw) => {
      expect(() => parseDevDomain(raw)).toThrow(InvalidDevDomainError);
      expect(() => parseDevDomain(raw)).toThrow(/workers\.dev|pages\.dev/);
    },
  );
});

describe("stageHosts", () => {
  test("H5: the production tier has no derived hosts", () => {
    expect(() => stageHosts("example.dev", "production")).toThrow(StageNotDeclaredError);
  });

  test("H6: an investigation stage puts every host under <stage>.<domain>", () => {
    const hosts = stageHosts("example.dev", "pr-7");
    for (const host of Object.values(hosts)) expect(host.endsWith(".pr-7.example.dev")).toBe(true);
  });

  test("H7: a derived host over 253 characters is refused, though the domain itself is valid", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(58)}.dev`;
    expect(long).toHaveLength(245);
    expect(parseDevDomain(long)).toBe(long);
    expect(() => stageHosts(long, "dev")).toThrow(InvalidDevDomainError);
  });
});
