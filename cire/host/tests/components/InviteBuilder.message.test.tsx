// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The builder's Message section as a destination. A link elsewhere in the
 * dashboard can ask the builder to open on it rather than on the first
 * section, and the section carries the copy action and the line pointing at
 * the other places that shape the message. The copy action on its own is
 * `invite/InviteMessageCopy.test.tsx`'s; here, how the builder feeds it. The
 * rest of the builder is `InviteBuilder.test.tsx`'s.
 */

const writeText = vi.fn<(t: string) => Promise<void>>();

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [{ id: "classic", name: "Classic", tier: "free" }],
  DEFAULT_DESIGN_ID: "classic",
}));

import InviteBuilder from "../../src/components/InviteBuilder";
import type { InviteView } from "../../src/lib/dashboard-route";
import { authFetchMock, resetOrganiserMocks, toastSuccess } from "../test-support/mocks";

const CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function loadCustomisation() {
  authFetchMock.mockResolvedValueOnce(json(CUSTOMISATION));
}

const HOUSEHOLDS = [
  {
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    guestCount: 2,
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

/** Answer every read by what it asks for: the customisation (with `extra`
 *  merged in) and the household list. */
function answerReads(extra: Record<string, unknown> = {}) {
  authFetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/households") ? json(HOUSEHOLDS) : json({ ...CUSTOMISATION, ...extra }),
  );
}

const householdReads = () =>
  authFetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/households")).length;

/** The builder on an Invite view, which the test can move like the route. */
function renderOn(start: InviteView, extra: { canEdit?: boolean; links?: boolean } = {}) {
  const [view, setView] = createSignal<InviteView>(start);
  render(() => (
    <InviteBuilder
      weddingId="wed_1"
      weddingSlug="anita-ben"
      weddingName="Anita & Ben"
      canEdit={extra.canEdit ?? true}
      entitlements={[]}
      view={view()}
      onView={setView}
      inviteMessageLinks={
        extra.links === false ? undefined : <p data-testid="invite-message-links" />
      }
    />
  ));
  return setView;
}

/** The message lives in Codes. */
const renderOnMessage = (canEdit = true) => renderOn("codes", { canEdit });

const picker = () => screen.getByLabelText("Household") as HTMLSelectElement;
const copyButton = () => screen.getByRole("button", { name: /^Copy / }) as HTMLButtonElement;
const lineField = () => screen.getByLabelText("Invite message (optional)") as HTMLTextAreaElement;

const messageCard = () => document.getElementById("invite-message") as HTMLFieldSetElement;

describe("InviteBuilder message, in Codes", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    writeText.mockReset();
  });

  it("shows the message in Codes alone, with its links once, inside it", async () => {
    loadCustomisation();
    const setView = renderOn("template");
    await waitFor(() => expect(messageCard()).toBeTruthy());
    expect(messageCard().hidden).toBe(true);

    setView("codes");
    expect(messageCard().hidden).toBe(false);
    const links = screen.getAllByTestId("invite-message-links");
    expect(links).toHaveLength(1);
    expect(messageCard().contains(links[0]!)).toBe(true);
  });

  it("puts the copy action in the message card, between the line and the links", async () => {
    answerReads();
    renderOnMessage();

    await waitFor(() => expect(picker().options.length).toBe(2));
    const card = messageCard();
    const links = screen.getByTestId("invite-message-links");
    expect(card.contains(picker())).toBe(true);
    expect(
      lineField().compareDocumentPosition(picker()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(picker().compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads the households only once Codes is shown, and once per builder", async () => {
    answerReads();
    const setView = renderOn("template");
    await waitFor(() => expect(messageCard()).toBeTruthy());
    expect(householdReads()).toBe(0);

    setView("codes");
    await waitFor(() => expect(picker().options.length).toBe(2));
    fireEvent.change(picker(), { target: { value: "fam_a" } });

    // Away and back: no second read, and the household is still chosen.
    setView("template");
    setView("codes");
    expect(householdReads()).toBe(1);
    expect(picker().value).toBe("fam_a");
  });

  it("copies the saved first line, and waits while the typed one differs", async () => {
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    answerReads({ inviteMessage: "Come to Goa!" });
    renderOnMessage();
    await waitFor(() => expect(picker().options.length).toBe(2));
    fireEvent.change(picker(), { target: { value: "fam_a" } });

    fireEvent.input(lineField(), { target: { value: "Come to Goa, bring sunscreen!" } });
    expect(copyButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Save the invite to copy the new first line.")).toBeTruthy();

    fireEvent.input(lineField(), { target: { value: "Come to Goa!" } });
    expect(copyButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(copyButton());

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [line, link, code] = writeText.mock.calls[0]![0].split("\n");
    expect(line).toBe("Come to Goa!");
    expect(link).toBe("http://localhost:4321/cire/invite?slug=anita-ben");
    expect(code).toBe("Your invitation code: SHARMA-KITE-77Q2");
  });

  it("copies the new first line once it is saved", async () => {
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // The text PUT answers with the customisation as saved, as the API does.
    authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/households")) return json(HOUSEHOLDS);
      if (url.endsWith("/invite/text")) {
        const sent = JSON.parse(String(init!.body)) as { inviteMessage: string | null };
        return json({ ...CUSTOMISATION, inviteMessage: sent.inviteMessage });
      }
      return json({ ...CUSTOMISATION, inviteMessage: "Come to Goa!" });
    });
    renderOnMessage();
    await waitFor(() => expect(picker().options.length).toBe(2));
    fireEvent.change(picker(), { target: { value: "fam_a" } });

    fireEvent.input(lineField(), { target: { value: "Come to Goa, bring sunscreen!" } });
    expect(copyButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(copyButton().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0].split("\n")[0]).toBe("Come to Goa, bring sunscreen!");
  });

  it("marks the household sent for an owner or editor, and not for anyone else", async () => {
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const marks = () =>
      authFetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/mark-shared")).length;

    for (const [canEdit, expected] of [
      [false, 0],
      [true, 1],
    ] as const) {
      answerReads();
      renderOnMessage(canEdit);
      await waitFor(() => expect(picker().options.length).toBe(2));
      fireEvent.change(picker(), { target: { value: "fam_a" } });
      fireEvent.click(copyButton());
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      await waitFor(() => expect(marks()).toBe(expected));
      cleanup();
      resetOrganiserMocks();
    }
  });

  it("reads a customisation with no saved line as the default line, not an unsaved one", async () => {
    // CUSTOMISATION carries no `inviteMessage` key at all.
    answerReads();
    renderOnMessage();
    await waitFor(() => expect(picker().options.length).toBe(2));

    expect(copyButton().getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByTestId("invite-message-preview").textContent).toMatch(
      /^You're invited to Anita & Ben!/,
    );
  });
});
