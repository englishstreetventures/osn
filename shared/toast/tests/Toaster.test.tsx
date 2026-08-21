// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "../src/index";
import { resetToasts, toasts } from "../src/store";
import { Toaster } from "../src/Toaster";

afterEach(() => {
  cleanup();
  resetToasts();
  vi.useRealTimers();
});

describe("Toaster", () => {
  it("renders a raised toast", async () => {
    render(() => <Toaster />);
    toast.success("Saved");
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("portals the container to <body>, so an animated ancestor can't trap it", () => {
    // A `transform` on an ancestor makes it the containing block AND a stacking
    // context for a `position: fixed` descendant — the exact mechanism that put
    // the cire RSVP toast behind the sheet it fires under. The portal is what
    // makes that impossible rather than merely discouraged.
    const { container } = render(() => (
      <div style={{ transform: "translateY(0)" }}>
        <Toaster />
      </div>
    ));
    expect(container.querySelector(".osn-toaster")).toBeNull();
    expect(document.body.querySelector(".osn-toaster")).toBeTruthy();
  });

  it("sets NO z-index of its own, and takes the layer from `class`", () => {
    // The library this replaced hardcoded `z-index: 9999` into the container's
    // inline style, which silently beat every class a caller passed and parked
    // toasts above the consent banner. An inline z-index here would be that bug.
    render(() => <Toaster class="z-150" />);
    const el = document.body.querySelector(".osn-toaster") as HTMLElement;
    expect(el.style.zIndex).toBe("");
    expect(el.className).toContain("z-150");
  });

  it("puts the message in an element whose textContent is EXACTLY the message", () => {
    // `cire/invites`'s browser test finds a toast with
    // `[...querySelectorAll("div")].find(d => d.textContent === message)`.
    // Folding the tone word into this element would break that lookup, and with
    // it the two-sided z-index regression guard it protects.
    render(() => <Toaster />);
    toast.error("Could not save");
    const match = [...document.querySelectorAll("div")].find(
      (d) => d.textContent === "Could not save",
    );
    expect(match, "no element whose textContent is exactly the message").toBeTruthy();
  });

  it("names the tone for assistive tech without showing the word", () => {
    render(() => <Toaster />);
    toast.error("Could not save");
    const sr = document.querySelector(".osn-toast__sr");
    expect(sr?.textContent).toBe("Error: ");
    expect(document.querySelector(".osn-toast__glyph")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("interrupts for an error and waits its turn for a confirmation", () => {
    render(() => <Toaster />);
    toast.error("Could not save");
    toast.success("Saved");
    const error = document.querySelector(".osn-toast--error")!;
    const success = document.querySelector(".osn-toast--success")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.getAttribute("aria-live")).toBe("assertive");
    expect(success.getAttribute("role")).toBe("status");
    expect(success.getAttribute("aria-live")).toBe("polite");
  });

  it("caps the stack at `limit`, dropping the oldest", () => {
    render(() => <Toaster limit={2} />);
    toast.info("One");
    toast.info("Two");
    toast.info("Three");
    expect(document.querySelectorAll(".osn-toast")).toHaveLength(2);
    expect(screen.queryByText("One")).toBeNull();
    expect(screen.getByText("Three")).toBeTruthy();
  });

  it("dismisses on its own once the dwell elapses", async () => {
    render(() => <Toaster />);
    toast.success("Saved", { duration: 50 });
    expect(screen.getByText("Saved")).toBeTruthy();
    await waitFor(() => expect(toasts()).toHaveLength(0), { timeout: 2000 });
  });

  it("pauses the dwell while the pointer is over it, so a toast can be read", async () => {
    render(() => <Toaster />);
    toast.success("Saved", { duration: 60 });
    const el = document.querySelector(".osn-toast") as HTMLElement;
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await new Promise((r) => setTimeout(r, 150));
    expect(toasts(), "the toast expired while being read").toHaveLength(1);
  });

  it("runs an action and then dismisses", async () => {
    const onClick = vi.fn();
    render(() => <Toaster />);
    toast.error("Could not save", { action: { label: "Retry", onClick }, duration: 10_000 });
    (screen.getByText("Retry") as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(toasts()).toHaveLength(0));
  });

  it("offers a dismiss button only when asked", async () => {
    render(() => <Toaster />);
    toast.info("Standing note", { dismissible: true, duration: 10_000 });
    const close = screen.getByLabelText("Dismiss notification");
    close.click();
    await waitFor(() => expect(toasts()).toHaveLength(0));
  });
});

describe("toast.promise", () => {
  it("turns one spinner into one result, in place", async () => {
    render(() => <Toaster />);
    let settle: (v: string) => void;
    const p = new Promise<string>((r) => {
      settle = r;
    });
    const done = toast.promise(p, {
      loading: "Saving…",
      success: (v) => `Saved ${v}`,
      error: "Failed",
    });
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(document.querySelectorAll(".osn-toast")).toHaveLength(1);

    settle!("draft");
    await done;
    // Same single toast, now the outcome — not a spinner vanishing and a tick
    // appearing elsewhere in the stack.
    expect(document.querySelectorAll(".osn-toast")).toHaveLength(1);
    expect(screen.getByText("Saved draft")).toBeTruthy();
  });

  it("re-throws, so a failed save can't look like a successful one to the caller", async () => {
    render(() => <Toaster />);
    const boom = new Error("nope");
    await expect(
      toast.promise(Promise.reject(boom), {
        loading: "Saving…",
        success: "Saved",
        error: (e) => `Failed: ${(e as Error).message}`,
      }),
    ).rejects.toThrow("nope");
    expect(screen.getByText("Failed: nope")).toBeTruthy();
  });

  it("gives the outcome its own dwell instead of inheriting the spinner's Infinity", async () => {
    render(() => <Toaster />);
    await toast.promise(
      Promise.resolve(1),
      { loading: "Saving…", success: "Saved", error: "No" },
      {
        duration: 60,
      },
    );
    expect(screen.getByText("Saved")).toBeTruthy();
    // Would hang for ever if the success inherited `loading`'s pinned duration.
    await waitFor(() => expect(toasts()).toHaveLength(0), { timeout: 2000 });
  });
});
