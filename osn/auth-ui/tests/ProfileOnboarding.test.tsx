// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const DISMISSED_KEY = "@osn/ui:profile_onboarding_dismissed";

const hoisted = vi.hoisted(() => {
  return {
    session: vi.fn((): { accessToken: string } | null => ({ accessToken: "tok" })),
    profiles: vi.fn(() => [
      { id: "p_1", handle: "alice", email: "a@b.com", displayName: null, avatarUrl: null },
    ]),
    createProfile: vi.fn(),
  };
});

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    session: hoisted.session,
    profiles: hoisted.profiles,
    createProfile: hoisted.createProfile,
  }),
}));

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProfileOnboarding } from "../src/ProfileOnboarding";
import { apiError } from "./helpers/errors";

describe("ProfileOnboarding", () => {
  beforeEach(() => {
    localStorage.removeItem(DISMISSED_KEY);
    hoisted.session.mockReturnValue({ accessToken: "tok" });
    hoisted.profiles.mockReturnValue([
      { id: "p_1", handle: "alice", email: "a@b.com", displayName: null, avatarUrl: null },
    ]);
    hoisted.createProfile.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render when user has multiple profiles", () => {
    hoisted.profiles.mockReturnValue([
      { id: "p_1", handle: "alice", email: "a@b.com", displayName: null, avatarUrl: null },
      { id: "p_2", handle: "bob", email: "b@b.com", displayName: null, avatarUrl: null },
    ]);
    render(() => <ProfileOnboarding />);
    expect(screen.queryByText("Add another profile")).toBeNull();
  });

  it("does not render when there is no session", () => {
    hoisted.session.mockReturnValue(null);
    render(() => <ProfileOnboarding />);
    expect(screen.queryByText("Add another profile")).toBeNull();
  });

  it("dismiss button hides card and persists to localStorage", () => {
    render(() => <ProfileOnboarding dismissible />);
    expect(screen.getByText("Add another profile")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Add another profile")).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
  });

  it("does not render when previously dismissed", () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    render(() => <ProfileOnboarding />);
    expect(screen.queryByText("Add another profile")).toBeNull();
  });

  it("clicking 'Create profile' opens the create dialog", async () => {
    render(() => <ProfileOnboarding />);
    fireEvent.click(screen.getByText("Create profile"));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Create a new profile" })).toBeTruthy();
    });
    // The form's Cancel is the dialog's dismiss button. Its `secondary` paint
    // and the sheet's placement take a real browser: musubi's
    // `ProfileOnboarding.browser.test.tsx` holds both.
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.closest("[role=dialog]")).toBeTruthy();
  });

  // The header holds the title alone; Cancel leads the footer pair, which
  // sits inside the form, so Enter in a field submits.
  it("puts Cancel first in the create dialog's footer, inside its form", async () => {
    render(() => <ProfileOnboarding />);
    fireEvent.click(screen.getByText("Create profile"));
    const title = await screen.findByRole("heading", { name: "Create a new profile" });
    expect(title.parentElement!.querySelectorAll("button")).toHaveLength(0);
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    const create = [...cancel.parentElement!.querySelectorAll("button")];
    expect(create.map((b) => b.textContent)).toEqual(["Cancel", "Create profile"]);
    expect(create[1]!.form).not.toBeNull();
    expect(create[1]!.form).toBe(screen.getByLabelText("Handle").closest("form"));
  });

  // Escape, a press outside and a drag down close the sheet, except while
  // the request it started runs. The drag reads the same `dismissible` that
  // refuses Escape here; `shared/ui/tests/dialog-drag.browser.test.tsx` ("a
  // sheet that cannot close") holds that it refuses the drag too.
  describe("closing the create sheet", () => {
    /**
     * Kobalte marks the panel `data-expanded` while it is open and
     * `data-closed` once it closes. happy-dom never ends the exit animation,
     * so a closed panel stays in the document: these read the mark.
     */
    const isOpen = (dialog: HTMLElement) => dialog.hasAttribute("data-expanded");

    /** Presses the card's Create profile, never the sheet's submit. */
    async function openSheet() {
      const card = screen
        .getAllByRole("button", { name: "Create profile" })
        .find((button) => !button.closest("[role=dialog]"));
      fireEvent.click(card!);
      const dialog = await screen.findByRole("dialog", { name: "Create a new profile" });
      await waitFor(() => expect(isOpen(dialog)).toBe(true));
      return dialog;
    }

    /** Types a handle and presses the sheet's Create profile. */
    function create(dialog: HTMLElement) {
      fireEvent.input(within(dialog).getByLabelText("Handle"), { target: { value: "bob" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));
    }

    function pressEscape(dialog: HTMLElement) {
      fireEvent.keyDown(dialog, { key: "Escape" });
    }

    function pressOutside() {
      fireEvent.pointerDown(document.body);
    }

    /** Lets every queued promise callback run, and a `setTimeout(0)` after them. */
    async function flush() {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    }

    // The positive control: the presses the refusals below send do close
    // the sheet when no request runs.
    it("closes on Escape and on a press outside before any request", async () => {
      render(() => <ProfileOnboarding />);
      const first = await openSheet();
      pressEscape(first);
      await waitFor(() => expect(isOpen(first)).toBe(false));

      const second = await openSheet();
      await flush();
      pressOutside();
      await waitFor(() => expect(isOpen(second)).toBe(false));
    });

    it("refuses Escape while the profile is created", async () => {
      hoisted.createProfile.mockReturnValue(new Promise(() => {}));
      render(() => <ProfileOnboarding />);
      const dialog = await openSheet();
      create(dialog);
      await within(dialog).findByRole("button", { name: "Creating…" });
      pressEscape(dialog);
      await flush();
      expect(isOpen(dialog)).toBe(true);
      expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeTruthy();
    });

    it("refuses a press outside while the profile is created", async () => {
      hoisted.createProfile.mockReturnValue(new Promise(() => {}));
      render(() => <ProfileOnboarding />);
      const dialog = await openSheet();
      await flush();
      create(dialog);
      await within(dialog).findByRole("button", { name: "Creating…" });
      pressOutside();
      await flush();
      expect(isOpen(dialog)).toBe(true);
      expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeTruthy();
    });

    it("closes on Escape again once the request fails", async () => {
      hoisted.createProfile.mockRejectedValue(apiError("PLANTED Handle taken"));
      render(() => <ProfileOnboarding />);
      const dialog = await openSheet();
      create(dialog);
      await within(dialog).findByRole("alert");
      pressEscape(dialog);
      await waitFor(() => expect(isOpen(dialog)).toBe(false));
    });

    it("closes itself once the profile is created, and opened again, closes on a press outside", async () => {
      hoisted.createProfile.mockResolvedValue({ id: "p_2", handle: "bob" });
      render(() => <ProfileOnboarding />);
      const first = await openSheet();
      create(first);
      await waitFor(() => expect(isOpen(first)).toBe(false));

      const second = await openSheet();
      await flush();
      pressOutside();
      await waitFor(() => expect(isOpen(second)).toBe(false));
    });
  });
});
