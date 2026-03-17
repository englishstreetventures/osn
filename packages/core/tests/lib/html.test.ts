import { describe, it, expect } from "vitest";
import { buildAuthorizeHtml } from "../../src/lib/html";

const baseParams = {
  clientId: "pulse",
  redirectUri: "http://localhost:5173/callback",
  state: "test-state-123",
  codeChallenge: "abc123challenge",
  codeChallengeMethod: "S256",
  scope: "openid profile",
  issuerUrl: "http://localhost:4000",
};

describe("buildAuthorizeHtml", () => {
  it("returns a complete HTML document", () => {
    const html = buildAuthorizeHtml(baseParams);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("contains the Sign in to OSN heading", () => {
    const html = buildAuthorizeHtml(baseParams);
    expect(html).toContain("Sign in to OSN");
  });

  it("injects all params into the inline script as JSON", () => {
    const html = buildAuthorizeHtml(baseParams);
    expect(html).toContain('"clientId":"pulse"');
    expect(html).toContain('"state":"test-state-123"');
    expect(html).toContain('"codeChallenge":"abc123challenge"');
    expect(html).toContain('"redirectUri":"http://localhost:5173/callback"');
    expect(html).toContain('"issuerUrl":"http://localhost:4000"');
  });

  it("serializes all params as JSON inside the inline script", () => {
    const html = buildAuthorizeHtml({
      ...baseParams,
      state: "my-state-value",
    });
    // Params are embedded via JSON.stringify — all keys must appear
    expect(html).toContain('"clientId"');
    expect(html).toContain('"state":"my-state-value"');
    expect(html).toContain('"redirectUri"');
    expect(html).toContain('"codeChallenge"');
    expect(html).toContain('"issuerUrl"');
  });

  it("includes three sign-in tabs", () => {
    const html = buildAuthorizeHtml(baseParams);
    expect(html).toContain('data-tab="passkey"');
    expect(html).toContain('data-tab="otp"');
    expect(html).toContain('data-tab="email"');
  });

  it("references the issuerUrl in the script body", () => {
    const html = buildAuthorizeHtml({ ...baseParams, issuerUrl: "https://auth.example.com" });
    expect(html).toContain('"issuerUrl":"https://auth.example.com"');
  });
});
