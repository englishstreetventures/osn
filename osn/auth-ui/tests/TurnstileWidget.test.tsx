// @vitest-environment happy-dom
import { render, cleanup, screen, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, afterEach, vi } from "vitest";

import { TurnstileWidget, turnstileEnabled } from "../src/TurnstileWidget";

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

describe("TurnstileWidget — a challenge that fails to load", () => {
  const CAUSES =
    "Couldn't load the verification challenge. A content blocker, a browser extension or a network that blocks challenges.cloudflare.com can stop it. Turn the blocker off for this site, or use another network.";

  type Api = {
    render: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  function setApi(api: Api | undefined) {
    if (api) (globalThis as unknown as { turnstile?: unknown }).turnstile = api;
    else delete (globalThis as unknown as { turnstile?: unknown }).turnstile;
  }

  /** An api.js whose `render` hands back a token at once. */
  function workingApi(): Api {
    return {
      render: vi.fn((_el: HTMLElement, opts: { callback?: (t: string) => void }) => {
        opts.callback?.("tok");
        return "wid-ok";
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
  }

  /**
   * Holds every `<script>` the widget appends instead of putting it in the
   * page, so nothing is fetched; a test fires its `load` or `error` itself.
   */
  function heldScripts(): HTMLScriptElement[] {
    const held: HTMLScriptElement[] = [];
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        held.push(node);
        return node;
      }
      return append(node);
    });
    return held;
  }

  /** The line's words, without the hidden "Error:" mark `Notice` reads before them. */
  function lineText(alert: HTMLElement): string {
    return (alert.textContent ?? "").replace(/^Error: /, "");
  }

  function tryAgain(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setApi(undefined);
  });

  it("names the causes a person can act on, with Try again, in an alert, when the script fails to load", async () => {
    const scripts = heldScripts();
    const onToken = vi.fn();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} />);

    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js");
    scripts[0]!.dispatchEvent(new Event("error"));

    const alert = await screen.findByRole("alert");
    expect(lineText(alert)).toBe(`${CAUSES} Try again`);
    expect(alert.contains(tryAgain())).toBe(true);
    expect(onToken).toHaveBeenCalledWith(null);
  });

  it("loads the script again on Try again, then renders and hands over a token", async () => {
    const scripts = heldScripts();
    const onToken = vi.fn();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} />);
    scripts[0]!.dispatchEvent(new Event("error"));
    await screen.findByRole("alert");

    tryAgain().click();
    expect(screen.queryByRole("alert")).toBeNull();
    // Focus goes to the challenge, not to the page, as the line it held goes.
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "Human verification challenge" }),
    );
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).not.toBe(scripts[0]);

    const api = workingApi();
    setApi(api);
    scripts[1]!.dispatchEvent(new Event("load"));
    await waitFor(() => expect(onToken).toHaveBeenLastCalledWith("tok"));
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fails a load that never finishes, at the deadline, rather than waiting for ever", async () => {
    vi.useFakeTimers();
    const scripts = heldScripts();
    const onToken = vi.fn();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} />);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(screen.queryByRole("alert")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lineText(screen.getByRole("alert"))).toBe(`${CAUSES} Try again`);
    expect(onToken).toHaveBeenCalledWith(null);

    tryAgain().click();
    expect(scripts).toHaveLength(2);
    // Settles the second load, so no load is left in flight for the next test.
    scripts[1]!.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("renders the challenge again on Try again after it reports an error", async () => {
    let fails = true;
    const api: Api = {
      render: vi.fn(
        (
          _el: HTMLElement,
          opts: { callback?: (t: string) => void; "error-callback"?: () => void },
        ) => {
          if (fails) opts["error-callback"]?.();
          else opts.callback?.("tok-2");
          return fails ? "wid-err" : "wid-ok";
        },
      ),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    setApi(api);
    const onToken = vi.fn();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} />);
    const alert = await screen.findByRole("alert");
    expect(lineText(alert)).toBe(`${CAUSES} Try again`);

    fails = false;
    tryAgain().click();
    await waitFor(() => expect(onToken).toHaveBeenLastCalledWith("tok-2"));
    expect(api.remove).toHaveBeenCalledWith("wid-err");
    expect(api.render).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes a failed script from the page, so Try again appends a new one rather than waiting on it", async () => {
    // A script element already in the page, as an earlier load left it: inert
    // here (no `src`), so nothing is fetched.
    const stale = document.createElement("script");
    stale.id = "cf-turnstile-script";
    document.head.append(stale);
    const scripts = heldScripts();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={() => {}} />);
    expect(scripts).toHaveLength(0);

    stale.dispatchEvent(new Event("error"));
    await screen.findByRole("alert");
    expect(stale.isConnected).toBe(false);
    expect(document.getElementById("cf-turnstile-script")).toBeNull();

    tryAgain().click();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toBe(stale);
    scripts[0]!.dispatchEvent(new Event("error"));
    await screen.findByRole("alert");
  });

  it("stops looking for the challenge once a load has failed, even after a late load event", async () => {
    vi.useFakeTimers();
    const stale = document.createElement("script");
    stale.id = "cf-turnstile-script";
    document.head.append(stale);
    heldScripts();
    render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={() => {}} />);
    stale.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders nothing for a load that lands after the widget has gone", async () => {
    const scripts = heldScripts();
    const onToken = vi.fn();
    const { unmount } = render(() => <TurnstileWidget siteKey="0x4AAAtest" onToken={onToken} />);
    unmount();

    const api = workingApi();
    setApi(api);
    scripts[0]!.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.render).not.toHaveBeenCalled();
    expect(onToken).not.toHaveBeenCalled();
  });

  it("adds the host's way on that needs no challenge, when it gives one", async () => {
    const scripts = heldScripts();
    render(() => (
      <TurnstileWidget
        siteKey="0x4AAAtest"
        onToken={() => {}}
        alternative="Signing in with a recovery code doesn't need this challenge: choose “Lost your passkey?”."
      />
    ));
    scripts[0]!.dispatchEvent(new Event("error"));
    const alert = await screen.findByRole("alert");
    expect(lineText(alert)).toBe(
      `${CAUSES} Signing in with a recovery code doesn't need this challenge: choose “Lost your passkey?”. Try again`,
    );
  });
});
