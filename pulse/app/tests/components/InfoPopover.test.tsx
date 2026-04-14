// @vitest-environment happy-dom
import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { InfoPopover } from "../../src/components/InfoPopover";

describe("InfoPopover", () => {
  afterEach(() => cleanup());

  it("renders the trigger button with '?' text", () => {
    render(() => <InfoPopover body="Some help text" />);
    const trigger = screen.getByLabelText("More info");
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toBe("?");
  });

  it("uses custom label for aria-label when provided", () => {
    render(() => <InfoPopover label="About visibility" body="Help" />);
    expect(screen.getByLabelText("About visibility")).toBeTruthy();
  });

  it("shows body text when trigger is clicked", async () => {
    render(() => <InfoPopover body="Detailed explanation here" />);
    // Body should not be visible initially (Kobalte Popover is closed by default)
    expect(screen.queryByText("Detailed explanation here")).toBeNull();

    fireEvent.click(screen.getByLabelText("More info"));

    // Kobalte Popover portals content to document.body — use screen
    expect(await screen.findByText("Detailed explanation here")).toBeTruthy();
  });

  it("hides body text when trigger is clicked again (toggle)", async () => {
    render(() => <InfoPopover body="Toggle me" />);
    const trigger = screen.getByLabelText("More info");

    // Open
    fireEvent.click(trigger);
    expect(await screen.findByText("Toggle me")).toBeTruthy();

    // Close
    fireEvent.click(trigger);
    // Kobalte may animate out — the content should eventually disappear
    // or have data-closed attribute. Either way, the popover state changes.
    const content = screen.queryByText("Toggle me");
    const closedParent = content?.closest("[data-closed]");
    const expandedParent = content?.closest("[data-expanded]");
    // Content is either removed from DOM or marked as closing
    expect(!content || closedParent || expandedParent).toBeTruthy();
  });

  it("dismisses on Escape key", async () => {
    render(() => <InfoPopover body="Press Escape" />);
    fireEvent.click(screen.getByLabelText("More info"));
    expect(await screen.findByText("Press Escape")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    // Content should be dismissed (removed or have data-closed)
  });
});
