import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import { AnimatedModal } from "./AnimatedModal";

// The open/close animation is imported dynamically; stub it so the modal's
// imperative reveal is a no-op under the test DOM.
vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

describe("AnimatedModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Defensive: ensure the body scroll lock is never left applied between tests.
    document.body.style.overflow = "";
  });

  it("names the dialog via labelledBy → the referenced title element", () => {
    const { getByRole, getByText } = render(() => (
      <AnimatedModal onClose={() => {}} labelledBy="modal-title">
        <h2 id="modal-title">Mehndi</h2>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("modal-title");
    // The accessible name resolves to the referenced title's text.
    expect(getByText("Mehndi").id).toBe("modal-title");
    // Querying the dialog by its accessible name succeeds.
    expect(getByRole("dialog", { name: "Mehndi" })).toBe(dialog);
  });

  it("falls back to an aria-label when no labelledBy is supplied", () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Event details");
    expect(dialog.getAttribute("aria-labelledby")).toBeNull();
  });

  it("moves focus to the close button on open", async () => {
    const { getByLabelText } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    await waitFor(() => {
      expect(document.activeElement).toBe(getByLabelText("Close"));
    });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(() => (
      <AnimatedModal onClose={onClose} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes via the close button", async () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(() => (
      <AnimatedModal onClose={onClose} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    fireEvent.click(getByLabelText("Close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("locks body scroll while open and restores it on close", async () => {
    const { unmount } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("restores focus to the trigger element when it unmounts", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <button type="button">Inside</button>
      </AnimatedModal>
    ));

    // Focus moves into the modal on open…
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));

    // …and returns to the trigger once the modal is gone.
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("reveals the panel to its final visible state under prefers-reduced-motion", async () => {
    const matchMediaSpy = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    vi.stubGlobal("matchMedia", matchMediaSpy);

    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    // Reduced motion short-circuits to the final visible state rather than
    // leaving the panel at its initial opacity-0 — the content must be visible.
    await waitFor(() => expect(dialog.style.opacity).toBe("1"));
    expect(dialog.style.transform).toBe("none");

    vi.unstubAllGlobals();
  });
});
