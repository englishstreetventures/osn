import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The RSVP editor's privacy link is built on `CIRE_MARKETING_URL`, which the
 * build bakes in from `PUBLIC_MARKETING_URL`. Read wrongly, a deployed portal
 * sends an organiser to a developer's machine instead of the privacy page. The
 * value is fixed when the module loads, so each case stubs the env and loads
 * it afresh.
 */
describe("CIRE_MARKETING_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(value: string | undefined): Promise<string> {
    vi.stubEnv("PUBLIC_MARKETING_URL", value);
    vi.resetModules();
    return (await import("../../src/lib/osn")).CIRE_MARKETING_URL;
  }

  it("is the origin the build sets", async () => {
    expect(await load("https://cireweddings.com")).toBe("https://cireweddings.com");
  });

  it("is the marketing site's local dev port when the build sets none", async () => {
    expect(await load(undefined)).toBe("http://localhost:4323");
  });
});
