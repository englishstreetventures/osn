import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONSENT_VENDORS, vendorById } from "@cire/ui/consent-vendors";
import { describe, expect, it } from "vitest";

import { API_ORIGIN, CSP_DIRECTIVES, CSP_REPORT_ENDPOINT } from "../../../src/lib/security-headers";

/*
 * The registry lives in `@cire/ui` because both sites publish the guest notice
 * built from it; its own shape is checked there
 * (`cire/ui/tests/consent-vendors.test.ts`). What it must agree with on this
 * site — the CSP and the `<ConsentGate>` ids in the source — is checked here.
 */

/**
 * The `vendor` id on every `<ConsentGate>` under `src/`, read from the source
 * text so the test sees the ids that actually ship.
 */
function gateVendorIds(): string[] {
  const srcDir = join(import.meta.dirname, "../../../src");
  const ids: string[] = [];
  for (const file of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const tag of source.matchAll(/<ConsentGate\b[^>]*>/g)) {
      const id = /\bvendor="([^"]+)"/.exec(tag[0])?.[1];
      if (id) ids.push(id);
    }
  }
  return ids;
}

/** Every origin named anywhere in the CSP, flattened. */
const cspOrigins = new Set<string>(Object.values(CSP_DIRECTIVES).flat());

describe("vendor registry ↔ CSP consistency", () => {
  it.each(CONSENT_VENDORS.filter((vendor) => vendor.origins.length > 0))(
    "declares $name's origins in the CSP",
    (vendor) => {
      // The registry and the CSP are two descriptions of the same fact: which
      // external origins this site talks to. Before the registry existed they
      // were maintained independently and drifted — a vendor added to one and
      // not the other either gets blocked in the browser (loud) or transfers
      // data nobody declared (silent). This test is the join between them.
      for (const origin of vendor.origins) {
        expect(cspOrigins.has(origin), `${vendor.name}: ${origin} missing from CSP`).toBe(true);
      }
    },
  );

  it("claims every third-party origin the CSP permits", () => {
    // The REVERSE direction, and the one that fails silently. A missing CSP
    // entry breaks the embed in the browser; a missing REGISTRY entry leaves an
    // origin that is contactable, CSP-permitted, and absent from the published
    // privacy notice, the preferences sheet and the subprocessor register —
    // because the guest privacy notice (`cire/ui/src/guest-privacy-notice.astro`)
    // generates its disclosure from this registry.
    //
    // Anything exempted below is FIRST-PARTY and therefore owes no third-party
    // disclosure. Adding to this list is the one place that has to be justified
    // in writing.
    const FIRST_PARTY = new Set<string>([
      // cire-api: invite JSON + image bytes. The build names its own tier's
      // API here — production, dev, or the local one — never a third party.
      API_ORIGIN,
      CSP_REPORT_ENDPOINT, // the violation collector on that same first-party API
    ]);

    const declared = new Set(CONSENT_VENDORS.flatMap((vendor) => vendor.origins));
    const undeclared = [...cspOrigins]
      .filter((source) => /^https?:\/\//.test(source))
      .filter((origin) => !FIRST_PARTY.has(origin) && !declared.has(origin));

    expect(undeclared, `CSP permits origins no vendor claims: ${undeclared.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps the gated vendors' script/frame origins in the CSP too", () => {
    // Specific spot-checks, so a broad CSP rewrite that drops one of these
    // fails here rather than in a guest's browser.
    expect(CSP_DIRECTIVES["script-src"]).toContain("https://assets.pinterest.com");
    expect(CSP_DIRECTIVES["frame-src"]).toContain("https://www.google.com");
  });

  // A vendor allowed to load script into the page runs code in it, so it must
  // say so. The CSP's `script-src` is a second record of which origins those
  // are, independent of the flag.
  it("marks every gated vendor whose origin may run script in the page as runsInPage", () => {
    const scriptOrigins = new Set<string>(CSP_DIRECTIVES["script-src"]);
    const loadsScript = CONSENT_VENDORS.filter(
      (vendor) =>
        vendor.enforcement === "gated" &&
        vendor.origins.some((origin) => scriptOrigins.has(origin)),
    );
    expect(loadsScript.map((vendor) => vendor.id)).toContain("pinterest");
    expect(
      loadsScript.filter((vendor) => vendor.enforcement === "gated" && !vendor.runsInPage),
    ).toEqual([]);
  });
});

describe("vendor ids in the source", () => {
  it("resolves every vendor id a `<ConsentGate>` in the source names to a gated vendor", () => {
    // `vendor` is a plain string prop, so a typo type-checks. It would degrade
    // the placeholder to "This content", and it would skip the reload that
    // withdrawing consent owes a vendor running in the page.
    const ids = gateVendorIds();
    expect(ids).toEqual(expect.arrayContaining(["google-maps", "pinterest"]));
    expect(ids.filter((id) => vendorById(id)?.enforcement !== "gated")).toEqual([]);
    expect(vendorById("nope")).toBeUndefined();
  });
});
