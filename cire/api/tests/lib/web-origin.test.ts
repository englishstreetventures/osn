import { describe, expect, it } from "bun:test";

import { siteOriginOptions, webOriginProblem } from "../../src/lib/web-origin";

const deployed = () => true;
const local = () => false;

describe("webOriginProblem", () => {
  it("accepts the committed dev and production lists", () => {
    expect(
      webOriginProblem(
        "https://invite.dev.cireweddings.com,https://host.dev.cireweddings.com,https://vendor.dev.cireweddings.com",
        deployed,
      ),
    ).toBeNull();
    expect(
      webOriginProblem(
        "https://invite.cireweddings.com, https://host.cireweddings.com, https://vendor.cireweddings.com",
        deployed,
      ),
    ).toBeNull();
  });

  it("accepts http://localhost with a port outside a deployed tier", () => {
    expect(webOriginProblem("http://localhost:4321", local)).toBeNull();
    expect(webOriginProblem("http://localhost", local)).toBeNull();
  });

  it("refuses http://localhost in a deployed tier", () => {
    expect(webOriginProblem("http://localhost:4321", deployed)).toBe(
      "WEB_ORIGIN entry 1 must be https:// (http://localhost only outside a deployed tier)",
    );
  });

  it("refuses a host that only starts with localhost, in every tier", () => {
    for (const tier of [local, deployed]) {
      expect(webOriginProblem("http://localhost.attacker.example", tier)).toContain(
        "must be https://",
      );
      expect(webOriginProblem("http://localhostfoo.com", tier)).toContain("must be https://");
    }
  });

  it("refuses plain http for any other host", () => {
    expect(webOriginProblem("http://app.example.com", local)).toContain("must be https://");
    expect(webOriginProblem("http://127.0.0.1:4321", local)).toContain("must be https://");
  });

  it("refuses an entry that is not exactly an origin", () => {
    for (const entry of [
      "https://app.example.com/",
      "https://app.example.com/path",
      "https://App.Example.com",
      "https://app.example.com:443",
      "https://user:secret@app.example.com",
    ]) {
      expect(webOriginProblem(entry, deployed)).toContain("must be a bare origin");
    }
  });

  it("refuses a schemeless or unparseable entry", () => {
    expect(webOriginProblem("app.example.com", deployed)).toBe("WEB_ORIGIN entry 1 is not a URL");
    expect(webOriginProblem("javascript:alert(1)", deployed)).toContain("must be a bare origin");
  });

  it("names the failing entry by position, never by its text", () => {
    const problem = webOriginProblem(
      "https://ok.example.com,https://user:secret@bad.example.com",
      deployed,
    );
    expect(problem).toContain("entry 2");
    expect(problem).not.toContain("secret");
  });

  it("refuses an empty list", () => {
    expect(webOriginProblem(" , ", deployed)).toBe("WEB_ORIGIN has no entries");
  });

  it("looks up the tier only when an http entry needs it", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return true;
    };
    webOriginProblem("https://a.example.com,https://b.example.com", counting);
    expect(calls).toBe(0);
    webOriginProblem("http://localhost:4321", counting);
    expect(calls).toBe(1);
  });
});

describe("siteOriginOptions", () => {
  const invites = "https://invite.cireweddings.com";
  const host = "https://host.cireweddings.com";
  const vendor = "https://vendor.cireweddings.com";

  it("maps the three entries, in order, to the guest, organiser and vendor origins", () => {
    expect(siteOriginOptions([invites, host, vendor])).toEqual({
      webOrigin: invites,
      organiserOrigin: host,
      vendorPortalOrigin: vendor,
    });
  });

  it("leaves out the key for a missing entry, so createApp's default applies", () => {
    const two = siteOriginOptions([invites, host]);
    expect(two).toEqual({ webOrigin: invites, organiserOrigin: host });
    expect(two).not.toHaveProperty("vendorPortalOrigin");
    expect(siteOriginOptions([])).toEqual({});
  });
});
