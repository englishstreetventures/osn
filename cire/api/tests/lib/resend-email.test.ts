import { describe, expect, it } from "bun:test";

import { localResendConfig, resendEmailConfig } from "../../src/lib/resend-email";

describe("resendEmailConfig", () => {
  it("has no transport and no problem without a key", () => {
    expect(resendEmailConfig({}, false)).toEqual({ config: null, problem: null });
    expect(resendEmailConfig({}, true)).toEqual({ config: null, problem: null });
  });

  it("sends from cire's verified sender to Resend itself with a key alone", () => {
    expect(resendEmailConfig({ RESEND_API_KEY: "re_x" }, true)).toEqual({
      config: { apiKey: "re_x", fromAddress: "hello@cireweddings.com" },
      problem: null,
    });
  });

  it("carries a loopback override outside a deployed tier", () => {
    expect(
      resendEmailConfig({ RESEND_API_KEY: "re_x", RESEND_API_URL: "http://localhost:4008" }, false),
    ).toEqual({
      config: {
        apiKey: "re_x",
        fromAddress: "hello@cireweddings.com",
        apiUrl: "http://localhost:4008",
      },
      problem: null,
    });
  });

  it("treats a blank override as unset", () => {
    expect(resendEmailConfig({ RESEND_API_KEY: "re_x", RESEND_API_URL: "  " }, true)).toEqual({
      config: { apiKey: "re_x", fromAddress: "hello@cireweddings.com" },
      problem: null,
    });
  });

  it("refuses any override in a deployed tier, leaving no transport", () => {
    const result = resendEmailConfig(
      { RESEND_API_KEY: "re_x", RESEND_API_URL: "http://localhost:4008" },
      true,
    );
    expect(result.config).toBeNull();
    expect(result.problem).toContain("RESEND_API_URL");
    expect(result.problem).toContain("deployed");
    expect(result.problem).not.toContain("localhost:4008");
  });

  it("refuses a non-loopback override in any tier, leaving no transport", () => {
    const result = resendEmailConfig(
      { RESEND_API_KEY: "re_x", RESEND_API_URL: "https://user:hunter2@mail.example.com" },
      false,
    );
    expect(result.config).toBeNull();
    expect(result.problem).toContain("RESEND_API_URL");
    expect(result.problem).not.toContain("hunter2");
    expect(result.problem).not.toContain("mail.example.com");
  });

  it("reports a bad override even without a key", () => {
    const result = resendEmailConfig({ RESEND_API_URL: "https://mail.example.com" }, false);
    expect(result.config).toBeNull();
    expect(result.problem).toContain("RESEND_API_URL");
  });
});

describe("localResendConfig", () => {
  it("keeps the recorder with a key alone, so a real key never sends real mail from the dev server", () => {
    expect(localResendConfig({ RESEND_API_KEY: "re_live" })).toBeNull();
  });

  it("keeps the recorder with an override alone", () => {
    expect(localResendConfig({ RESEND_API_URL: "http://localhost:4008" })).toBeNull();
  });

  it("sends to the emulator when the key and a loopback override are both set", () => {
    expect(
      localResendConfig({ RESEND_API_KEY: "re_local", RESEND_API_URL: "http://localhost:4008" }),
    ).toEqual({
      apiKey: "re_local",
      fromAddress: "hello@cireweddings.com",
      apiUrl: "http://localhost:4008",
    });
  });

  it("throws on a refused override, naming the variable but not the value", () => {
    let message = "";
    try {
      localResendConfig({
        RESEND_API_KEY: "re_local",
        RESEND_API_URL: "https://user:hunter2@mail.example.com",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("RESEND_API_URL");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("mail.example.com");
  });
});

describe("wrangler.toml", () => {
  // A deployed tier refuses RESEND_API_URL by turning mail off, so no committed
  // tier may set it. Comment lines may name it.
  it("sets RESEND_API_URL in no tier", async () => {
    const assignments = (await Bun.file(new URL("../../wrangler.toml", import.meta.url)).text())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /["']?RESEND_API_URL["']?\s*=/.test(line));
    expect(assignments).toEqual([]);
  });
});
