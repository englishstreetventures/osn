import { describe, it, expect } from "vitest";
import { app } from "../src/index";

describe("OSN auth server", () => {
  describe("GET /", () => {
    it("returns status ok", async () => {
      const res = await app.handle(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; service: string };
      expect(json.status).toBe("ok");
      expect(json.service).toBe("osn-auth");
    });
  });

  describe("GET /health", () => {
    it("returns ok status from shared observability health route", async () => {
      const res = await app.handle(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; service: string };
      expect(json.status).toBe("ok");
      expect(json.service).toBe("osn-app");
    });
  });

  describe("GET /.well-known/openid-configuration", () => {
    it("returns OIDC discovery document", async () => {
      const res = await app.handle(
        new Request("http://localhost/.well-known/openid-configuration"),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
      };
      expect(json.issuer).toContain("localhost");
      expect(json.authorization_endpoint).toContain("/authorize");
      expect(json.token_endpoint).toContain("/token");
    });
  });
});
