// @vitest-environment happy-dom
import { render, cleanup, screen } from "@solidjs/testing-library";
import { describe, it, expect, afterEach, vi } from "vitest";

import { TurnstileWidget, turnstileEnabled } from "../../src/auth/TurnstileWidget";

/**
 * Key-optional render contract for the OSN auth Turnstile widget. When no
 * sitekey is provided it must render NOTHING (and never inject the Cloudflare
 * script tag) so the surrounding auth forms behave exactly as before Turnstile.
 */

afterEach(() => {
  cleanup();
  document.getElementById("cf-turnstile-script")?.remove();
});

describe("turnstileEnabled", () => {
  it("is false for undefined / blank, true for a real key", () => {
    expect(turnstileEnabled(undefined)).toBe(false);
    expect(turnstileEnabled("")).toBe(false);
    expect(turnstileEnabled("   ")).toBe(false);
    expect(turnstileEnabled("0x4AAA")).toBe(true);
  });
});

describe("TurnstileWidget — unconfigured renders nothing", () => {
  it("renders no container and injects no script when siteKey is undefined", () => {
    const onToken = vi.fn();
    const { container } = render(() => <TurnstileWidget siteKey={undefined} onToken={onToken} />);
    expect(container.querySelector("div")).toBeNull();
    expect(document.getElementById("cf-turnstile-script")).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });

  it("renders the challenge wrapper + a11y label when a sitekey is present", () => {
    const onToken = vi.fn();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} />);
    // The accessible label is always present in the configured branch.
    expect(screen.getByText("Human verification challenge")).toBeTruthy();
  });
});
