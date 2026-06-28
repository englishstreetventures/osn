import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DemoRsvp } from "./DemoRsvp";

// The demo must never touch the network — it's a no-op preview. We mock motion
// (modal choreography) and spy on fetch to prove nothing is ever sent.
vi.mock("./Modal.motion", () => ({
  modalEnter: vi.fn(),
  modalExit: vi.fn(() => Promise.resolve()),
}));

function fieldsetFor(name: string): HTMLElement {
  const legends = document.querySelectorAll("legend");
  for (const l of legends) {
    if ((l.textContent ?? "").includes(name)) {
      return l.closest("fieldset") as HTMLElement;
    }
  }
  throw new Error(`fieldset for ${name} not found`);
}

describe("DemoRsvp", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders the demo invitation with both events", () => {
    const { getByText } = render(() => <DemoRsvp />);
    expect(getByText("Amara & Sam")).toBeTruthy();
    expect(getByText("The Ceremony")).toBeTruthy();
    expect(getByText("The Reception")).toBeTruthy();
  });

  it("opens an interactive RSVP modal that announces it won't be saved", async () => {
    const { getAllByText, getByText, getByRole } = render(() => <DemoRsvp />);

    fireEvent.click(getAllByText("Respond")[0]!);

    await waitFor(() => expect(getByRole("dialog")).toBeTruthy());
    expect(getByText(/won.t be saved/i)).toBeTruthy();
  });

  it("blocks submit until everyone in the party has answered", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getAllByText, getByText } = render(() => <DemoRsvp />);

    fireEvent.click(getAllByText("Respond")[0]!);
    await waitFor(() => expect(getByText("Send RSVP")).toBeTruthy());

    fireEvent.click(getByText("Send RSVP"));

    await waitFor(() =>
      expect(getByText("Please respond for everyone in your party.")).toBeTruthy(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("confirms with a no-op message and never calls the network on a valid submit", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getAllByText, getByText } = render(() => <DemoRsvp />);

    fireEvent.click(getAllByText("Respond")[0]!);
    await waitFor(() => expect(getByText("Send RSVP")).toBeTruthy());

    // Answer for both members in the party.
    fireEvent.click(within(fieldsetFor("Amara")).getByText("Attending"));
    fireEvent.click(within(fieldsetFor("Sam")).getByText("Not attending"));

    fireEvent.click(getByText("Send RSVP"));

    await waitFor(() => expect(getByText(/That.s the feeling/i)).toBeTruthy());
    expect(getByText(/nothing is saved/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
