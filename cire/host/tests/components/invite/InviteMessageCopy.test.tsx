// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The copy action beside the invite message, in the builder's Message section.
 * It copies one household's full message — the saved first line, the
 * guest-site link and the household's code — or, with no household chosen, the
 * same message with a placeholder where the code goes. An owner's copy marks
 * the household sent, as the copy in Guests → Households does.
 */

const writeText = vi.fn<(t: string) => Promise<void>>();

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../../test-support/mocks");
  return toastMock();
});

vi.mock("../../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../../test-support/mocks");
  return organiserApiMock();
});

vi.mock("../../../src/lib/osn", () => ({ CIRE_WEB_URL: "https://guests.test" }));

import InviteMessageCopy from "../../../src/components/invite/InviteMessageCopy";
import type { OrganiserHouseholdRow } from "../../../src/lib/households-store";
import {
  authFetchMock,
  redirectSpy,
  resetOrganiserMocks,
  toastError,
  toastSuccess,
} from "../../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function household(over: Partial<OrganiserHouseholdRow>): OrganiserHouseholdRow {
  return {
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    guestCount: 2,
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
    ...over,
  };
}

const HOUSEHOLDS = [
  household({}),
  household({
    familyId: "fam_b",
    publicId: "JONES-BELL-12AB",
    familyName: "Jones",
    guestCount: 1,
    codeSharedAt: 1_700_000_000_000,
  }),
  // A code-only household (no guests yet) and a deactivated one: neither code
  // gets anyone into an invitation, so neither is offered.
  household({ familyId: "fam_c", publicId: "EMPTY-CODE", familyName: "Empty", guestCount: 0 }),
  household({
    familyId: "fam_d",
    publicId: "GONE-CODE",
    familyName: "Gone",
    deactivatedAt: 1_700_000_000_000,
  }),
];

const HOUSEHOLDS_URL = "https://api.test/api/organiser/weddings/wed_1/households";
const MARK_URL = "https://api.test/api/organiser/weddings/wed_1/families/fam_a/mark-shared";

function withClipboard() {
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

interface Setup {
  canEdit?: boolean;
  savedLine?: string | null;
  draftLine?: string;
}

/** Mount with the households read answered by `answer`. Returns a setter for
 *  the typed line, so a test can make the draft differ from the saved one. */
function mount(answer: Response | Error = json(HOUSEHOLDS), setup: Setup = {}) {
  if (answer instanceof Error) authFetchMock.mockRejectedValueOnce(answer);
  else authFetchMock.mockResolvedValueOnce(answer);
  const [draftLine, setDraftLine] = createSignal(setup.draftLine ?? setup.savedLine ?? "");
  render(() => (
    <InviteMessageCopy
      weddingId="wed_1"
      weddingName="Nadia & Sam"
      weddingSlug="nadia-sam"
      canEdit={setup.canEdit ?? true}
      savedLine={setup.savedLine ?? null}
      draftLine={draftLine()}
    />
  ));
  return { setDraftLine };
}

const picker = () => screen.getByLabelText("Household") as HTMLSelectElement;
const optionLabels = () => Array.from(picker().options).map((o) => o.textContent);
const copyButton = () => screen.getByRole("button", { name: /^Copy / }) as HTMLButtonElement;
const preview = () => screen.getByTestId("invite-message-preview").textContent;

async function loaded() {
  await waitFor(() => expect(picker().options.length).toBeGreaterThan(1));
}

describe("InviteMessageCopy", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    writeText.mockReset();
  });

  it("offers every household whose code opens an invitation, marking those already sent", async () => {
    mount();
    await loaded();

    expect(authFetchMock).toHaveBeenCalledWith(HOUSEHOLDS_URL);
    expect(optionLabels()).toEqual([
      "No household (placeholder code)",
      "Sharma · SHARMA-KITE-77Q2",
      "Jones · JONES-BELL-12AB · sent",
    ]);
    expect(picker().value).toBe("");
  });

  it("with no household chosen, copies the message with a placeholder and marks nothing", async () => {
    withClipboard();
    mount(json(HOUSEHOLDS), { savedLine: "Come to Goa!" });
    await loaded();

    expect(copyButton().textContent).toBe("Copy template");
    fireEvent.click(copyButton());

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe(
      "Come to Goa!\nhttps://guests.test/nadia-sam\nYour invitation code: [household code]",
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Copied the message with a placeholder for the code",
      ),
    );
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("copies the chosen household's message, marks it sent, and keeps it chosen", async () => {
    withClipboard();
    mount();
    await loaded();
    fireEvent.change(picker(), { target: { value: "fam_a" } });
    expect(copyButton().textContent).toBe("Copy message");
    expect(preview()).toBe(
      "You're invited to Nadia & Sam! View your invitation and RSVP below.\n" +
        "https://guests.test/nadia-sam\n" +
        "Your invitation code: SHARMA-KITE-77Q2",
    );

    authFetchMock.mockResolvedValueOnce(json({ familyId: "fam_a", codeSharedAt: 5 }));
    fireEvent.click(copyButton());

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe(preview());
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Copied Sharma's invite message"),
    );
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledWith(MARK_URL, { method: "POST" }));
    await waitFor(() => expect(optionLabels()[1]).toBe("Sharma · SHARMA-KITE-77Q2 · sent"));
    // The mark relabels the option in place: the picker still shows Sharma.
    expect(picker().value).toBe("fam_a");
    expect(picker().selectedOptions[0]!.textContent).toBe("Sharma · SHARMA-KITE-77Q2 · sent");
  });

  it("leaves the household unmarked when the server refuses or cannot be reached", async () => {
    withClipboard();
    for (const refuse of [
      () => authFetchMock.mockResolvedValueOnce(json({ error: "forbidden" }, 403)),
      () => authFetchMock.mockRejectedValueOnce(new TypeError("network down")),
    ]) {
      mount();
      await loaded();
      fireEvent.change(picker(), { target: { value: "fam_a" } });
      refuse();
      fireEvent.click(copyButton());

      await waitFor(() => expect(authFetchMock).toHaveBeenCalledWith(MARK_URL, { method: "POST" }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      // The copy happened; only the mark failed, and that is not the organiser's to fix.
      expect(optionLabels()[1]).toBe("Sharma · SHARMA-KITE-77Q2");
      expect(toastError).not.toHaveBeenCalled();
      cleanup();
      resetOrganiserMocks();
    }
  });

  it("for a viewer, copies the message but marks nothing, since only an owner or editor may", async () => {
    withClipboard();
    mount(json(HOUSEHOLDS), { canEdit: false });
    await loaded();
    fireEvent.change(picker(), { target: { value: "fam_a" } });

    fireEvent.click(copyButton());

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toContain("SHARMA-KITE-77Q2");
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(optionLabels()[1]).toBe("Sharma · SHARMA-KITE-77Q2");
  });

  it("previews the line being typed, and holds the copy until it is saved", async () => {
    withClipboard();
    const { setDraftLine } = mount(json(HOUSEHOLDS), { savedLine: "Come to Goa!" });
    await loaded();
    expect(copyButton().getAttribute("aria-disabled")).toBeNull();

    setDraftLine("Come to Goa, bring sunscreen!");

    expect(preview()!.split("\n")[0]).toBe("Come to Goa, bring sunscreen!");
    expect(copyButton().getAttribute("aria-disabled")).toBe("true");
    // Still in the tab order, and it says why it will not copy.
    expect(copyButton().disabled).toBe(false);
    const note = screen.getByText("Save the invite to copy the new first line.");
    expect(copyButton().getAttribute("aria-describedby")).toBe(note.id);
    fireEvent.click(copyButton());
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();

    // Only whitespace differs: the copy would be the same text, so it is free.
    setDraftLine("Come to Goa!  ");
    expect(copyButton().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText("Save the invite to copy the new first line.")).toBeNull();
  });

  it("says so when the households cannot be read, and still copies the template", async () => {
    withClipboard();
    mount(json({ error: "nope" }, 500));

    const note = await waitFor(() =>
      screen.getByText("Could not load the households. Refresh to try again."),
    );
    expect(picker().getAttribute("aria-describedby")).toBe(note.id);
    expect(optionLabels()).toEqual(["No household (placeholder code)"]);
    fireEvent.click(copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it("treats a thrown read like a refused one", async () => {
    mount(new TypeError("network down"));

    await waitFor(() =>
      expect(screen.getByText("Could not load the households. Refresh to try again.")).toBeTruthy(),
    );
  });

  it("sends a signed-out organiser to sign in", async () => {
    mount(json({ error: "unauthorised" }, 401));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("sends an organiser whose session cannot be refreshed to sign in", async () => {
    mount(new Error("AuthExpiredError"));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    expect(screen.queryByText("Could not load the households. Refresh to try again.")).toBeNull();
  });

  it("says when there is no household to choose yet", async () => {
    mount(json([household({ guestCount: 0 })]));

    const note = await waitFor(() => screen.getByText("No households to choose yet."));
    expect(picker().getAttribute("aria-describedby")).toBe(note.id);
  });

  it("points at the preview when the clipboard refuses", async () => {
    // No navigator.clipboard, and execCommand returns false.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    mount();
    await loaded();
    fireEvent.change(picker(), { target: { value: "fam_a" } });

    fireEvent.click(copyButton());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't copy automatically. Select the message above and copy it by hand.",
      ),
    );
    // Nothing reached the clipboard, so nothing is marked sent.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});
