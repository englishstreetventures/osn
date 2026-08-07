import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach, vi } from "vitest";

import { TurnstileWidget, turnstileEnabled, turnstileSiteKey } from "./TurnstileWidget";

/**
 * Key-optional render contract for the guest-site Turnstile widget. The sitekey
 * is read from `import.meta.env.PUBLIC_TURNSTILE_SITEKEY` (stubbed here). When
 * unset, the widget renders nothing and never injects the Cloudflare script, so
 * the claim + RSVP forms behave exactly as before Turnstile existed.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  document.getElementById("cf-turnstile-script")?.remove();
});

describe("turnstileEnabled / turnstileSiteKey", () => {
  it("is disabled when the env var is unset", () => {
    vi.stubEnv("PUBLIC_TURNSTILE_SITEKEY", "");
    expect(turnstileSiteKey()).toBeUndefined();
    expect(turnstileEnabled()).toBe(false);
  });

  it("is enabled when a sitekey is configured", () => {
    vi.stubEnv("PUBLIC_TURNSTILE_SITEKEY", "0x4AAAtest");
    expect(turnstileSiteKey()).toBe("0x4AAAtest");
    expect(turnstileEnabled()).toBe(true);
  });
});

describe("TurnstileWidget render", () => {
  it("renders nothing + injects no script when unconfigured", () => {
    vi.stubEnv("PUBLIC_TURNSTILE_SITEKEY", "");
    const onToken = vi.fn();
    const { container } = render(() => <TurnstileWidget onToken={onToken} />);
    expect(container.querySelector("div")).toBeNull();
    expect(document.getElementById("cf-turnstile-script")).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });

  it("renders the challenge wrapper when configured", () => {
    vi.stubEnv("PUBLIC_TURNSTILE_SITEKEY", "0x4AAAtest");
    const onToken = vi.fn();
    const { container } = render(() => <TurnstileWidget onToken={onToken} />);
    expect(container.querySelector("div")).not.toBeNull();
  });

  it("fails closed when render() throws: hint shown, onToken(null)", async () => {
    vi.stubEnv("PUBLIC_TURNSTILE_SITEKEY", "0x4AAAtest");
    // A pre-loaded `window.turnstile` makes loadTurnstileScript resolve
    // immediately; a throwing render() exercises the onMount catch.
    (globalThis as { turnstile?: unknown }).turnstile = {
      render: () => {
        throw new Error("render boom");
      },
      remove: () => {},
      reset: () => {},
    };
    try {
      const onToken = vi.fn();
      const { findByRole } = render(() => <TurnstileWidget onToken={onToken} />);
      const alert = await findByRole("alert");
      expect(alert.textContent).toContain("verification challenge");
      expect(onToken).toHaveBeenCalledWith(null);
    } finally {
      delete (globalThis as { turnstile?: unknown }).turnstile;
    }
  });
});
