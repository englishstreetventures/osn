// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * EditWorkspace is the Edit sub-tab's one choice: change this module's data with
 * the on-page editor, or by uploading its CSV. The two are alternatives, not
 * views — so what these pin is the switching itself: the editor is the default,
 * only one surface is mounted at a time, the import is scoped to this module's
 * sheet, and an unsaved editor draft can't be thrown away without a confirm.
 */

vi.mock("./ImportPanel", () => ({
  default: (p: { weddingId: string; kind: string }) => (
    <div data-testid="import" data-kind={p.kind}>
      {p.weddingId}
    </div>
  ),
}));

import { registerUnsavedGuard } from "../lib/unsaved-guard";
import EditWorkspace from "./EditWorkspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** happy-dom ships no window.confirm — stub it per test. */
function stubConfirm(answer: boolean) {
  const spy = vi.fn().mockReturnValue(answer);
  vi.stubGlobal("confirm", spy);
  return spy;
}

/** Mounted only while "editor" is chosen — so a testid that appears and
 *  disappears is the proof the other surface isn't quietly still there. */
function Editor() {
  return <div data-testid="editor">the web editor</div>;
}

function mount(kind: "events" | "guests" = "guests") {
  return render(() => <EditWorkspace weddingId="wed_a" kind={kind} editor={() => <Editor />} />);
}

const mode = (name: RegExp) => screen.getByRole("radio", { name });

describe("EditWorkspace", () => {
  it("offers both ways in, and starts on the editor", () => {
    mount();
    expect(mode(/web editor/i).getAttribute("aria-checked")).toBe("true");
    expect(mode(/spreadsheet import/i).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("editor")).toBeTruthy();
    // The import panel is not merely hidden — it never mounted, so nothing it
    // does on mount (fetching change history) runs until it is chosen.
    expect(screen.queryByTestId("import")).toBeNull();
  });

  it("swaps the editor for the import, and back", () => {
    mount();
    fireEvent.click(mode(/spreadsheet import/i));
    expect(screen.getByTestId("import")).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();

    fireEvent.click(mode(/web editor/i));
    expect(screen.getByTestId("editor")).toBeTruthy();
    expect(screen.queryByTestId("import")).toBeNull();
  });

  it("gives the import the module's own sheet", () => {
    mount("events");
    fireEvent.click(mode(/spreadsheet import/i));
    expect(screen.getByTestId("import").getAttribute("data-kind")).toBe("events");
  });

  it("asks before dropping an unsaved editor draft", () => {
    // The editor registers a dirty-check while mounted; switching mode unmounts
    // it, which would take the draft with it.
    const confirm = stubConfirm(false);
    const unregister = registerUnsavedGuard(() => true);
    mount();

    fireEvent.click(mode(/spreadsheet import/i));
    expect(confirm).toHaveBeenCalled();
    // Declined ⇒ nothing moved.
    expect(screen.getByTestId("editor")).toBeTruthy();
    expect(mode(/web editor/i).getAttribute("aria-checked")).toBe("true");

    confirm.mockReturnValue(true);
    fireEvent.click(mode(/spreadsheet import/i));
    expect(screen.getByTestId("import")).toBeTruthy();
    unregister();
  });

  it("switches silently when the draft is clean", () => {
    const confirm = stubConfirm(true);
    const unregister = registerUnsavedGuard(() => false);
    mount();

    fireEvent.click(mode(/spreadsheet import/i));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("import")).toBeTruthy();
    unregister();
  });

  it("never asks on the way BACK from import (there is no draft to lose)", () => {
    const confirm = stubConfirm(true);
    mount();
    fireEvent.click(mode(/spreadsheet import/i));
    // A dirty guard registered by something else must not make returning to the
    // editor — which loses nothing — feel like a destructive step.
    const unregister = registerUnsavedGuard(() => true);
    fireEvent.click(mode(/web editor/i));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor")).toBeTruthy();
    unregister();
  });

  it("explains each mode in text an AT can resolve, not a hover tooltip", () => {
    // C-L1 — the hints used to live only in `title`: unreachable on touch,
    // unreachable by keyboard, inconsistently announced. Each control now points
    // at a real paragraph, and BOTH ids must resolve even though only the active
    // hint is shown — an `aria-describedby` pointing at nothing is no
    // description at all.
    mount();
    for (const name of [/web editor/i, /spreadsheet import/i]) {
      const control = mode(name);
      expect(control.getAttribute("title")).toBeNull();
      const described = document.getElementById(control.getAttribute("aria-describedby")!);
      expect(described, `${name} has an unresolvable aria-describedby`).toBeTruthy();
      expect(described!.textContent).toBeTruthy();
    }
    // Only the active one is on screen.
    const active = document.getElementById(mode(/web editor/i).getAttribute("aria-describedby")!)!;
    const inactive = document.getElementById(
      mode(/spreadsheet import/i).getAttribute("aria-describedby")!,
    )!;
    expect(active.hidden).toBe(false);
    expect(inactive.hidden).toBe(true);
  });

  it("re-clicking the current mode is a no-op", () => {
    const confirm = stubConfirm(false);
    const unregister = registerUnsavedGuard(() => true);
    mount();
    fireEvent.click(mode(/web editor/i));
    // No confirm, because nothing is being unmounted.
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor")).toBeTruthy();
    unregister();
  });
});
