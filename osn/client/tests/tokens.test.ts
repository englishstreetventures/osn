import { describe, expect, it } from "vitest";

import { parseTokenResponse } from "../src/tokens";

const validFull = {
  access_token: "at_abc123",
  refresh_token: "rt_xyz789",
  id_token: "id_tok_456",
  expires_in: 3600,
  token_type: "Bearer",
  scope: "openid profile email",
};

const validMinimal = {
  access_token: "at_abc123",
  expires_in: 3600,
  token_type: "Bearer",
};

describe("parseTokenResponse", () => {
  describe("valid input", () => {
    it("parses a full token response", () => {
      const session = parseTokenResponse(validFull);
      expect(session.accessToken).toBe("at_abc123");
      expect(session.refreshToken).toBe("rt_xyz789");
      expect(session.idToken).toBe("id_tok_456");
      expect(session.expiresAt).toBeGreaterThan(Date.now());
      expect(session.scopes).toEqual(["openid", "profile", "email"]);
    });

    it("parses a minimal token response (optional fields absent)", () => {
      const session = parseTokenResponse(validMinimal);
      expect(session.accessToken).toBe("at_abc123");
      expect(session.refreshToken).toBeNull();
      expect(session.idToken).toBeNull();
      expect(session.scopes).toEqual([]);
    });

    it("calculates expiresAt from expires_in", () => {
      const before = Date.now();
      const session = parseTokenResponse(validMinimal);
      const after = Date.now();
      expect(session.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(session.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
    });
  });

  describe("scope parsing", () => {
    it("splits multi-word scope", () => {
      const session = parseTokenResponse({ ...validMinimal, scope: "openid profile" });
      expect(session.scopes).toEqual(["openid", "profile"]);
    });

    it("handles single-word scope", () => {
      const session = parseTokenResponse({ ...validMinimal, scope: "openid" });
      expect(session.scopes).toEqual(["openid"]);
    });

    it("returns empty array for empty string scope", () => {
      const session = parseTokenResponse({ ...validMinimal, scope: "" });
      expect(session.scopes).toEqual([]);
    });
  });

  describe("invalid input", () => {
    it("throws on missing access_token", () => {
      expect(() => parseTokenResponse({ expires_in: 3600, token_type: "Bearer" })).toThrow();
    });

    it("throws on missing expires_in", () => {
      expect(() => parseTokenResponse({ access_token: "at_abc", token_type: "Bearer" })).toThrow();
    });

    it("throws on wrong type for expires_in", () => {
      expect(() =>
        parseTokenResponse({
          access_token: "at_abc",
          expires_in: "not_a_number",
          token_type: "Bearer",
        }),
      ).toThrow();
    });

    it("throws on null input", () => {
      expect(() => parseTokenResponse(null)).toThrow();
    });

    it("throws on empty object", () => {
      expect(() => parseTokenResponse({})).toThrow();
    });
  });
});
