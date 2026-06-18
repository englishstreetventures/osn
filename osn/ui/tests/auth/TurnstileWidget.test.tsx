// @vitest-environment happy-dom
import { render, cleanup, screen, waitFor } from "@solidjs/testing-library";
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

describe("TurnstileWidget — single-use reset (onReady)", () => {
  afterEach(() => {
    delete (globalThis as unknown as { turnstile?: unknown }).turnstile;
  });

  it("hands the parent a reset() that drops the stale token then resets the widget", async () => {
    let cb: ((token: string) => void) | undefined;
    const reset = vi.fn();
    (globalThis as unknown as { turnstile?: unknown }).turnstile = {
      render: vi.fn((_el: HTMLElement, opts: { callback?: (t: string) => void }) => {
        cb = opts.callback;
        cb?.("first-token");
        return "wid-1";
      }),
      reset,
      remove: vi.fn(),
    };

    const onToken = vi.fn();
    let controls: { reset: () => void } | undefined;
    render(() => (
      <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} onReady={(c) => (controls = c)} />
    ));

    await waitFor(() => expect(controls).toBeDefined());
    await waitFor(() => expect(onToken).toHaveBeenCalledWith("first-token"));

    controls!.reset();
    // The stale token is dropped synchronously (null) so the form can't replay it,
    expect(onToken).toHaveBeenCalledWith(null);
    // and the underlying Cloudflare widget is reset to mint a fresh challenge.
    expect(reset).toHaveBeenCalledWith("wid-1");
  });
});
