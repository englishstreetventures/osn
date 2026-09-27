// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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

function renderOnMessage(canManage = true) {
  render(() => (
    <InviteBuilder
      weddingId="wed_1"
      weddingSlug="anita-ben"
      weddingName="Anita & Ben"
      canManage={canManage}
      entitlements={[]}
      initialSection="invite-message"
      inviteMessageLinks={<p data-testid="invite-message-links" />}
    />
  ));
}

const picker = () => screen.getByLabelText("Household") as HTMLSelectElement;
const copyButton = () => screen.getByRole("button", { name: /^Copy / }) as HTMLButtonElement;
const lineField = () => screen.getByLabelText("Invite message (optional)") as HTMLTextAreaElement;

const messageCard = () => document.getElementById("invite-message") as HTMLFieldSetElement;

describe("InviteBuilder Message section", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    writeText.mockReset();
  });

  it("opens on the first section when nothing asks otherwise", async () => {
    loadCustomisation();
    render(() => (
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        weddingName="Anita & Ben"
        canManage
        entitlements={[]}
      />
    ));

    const design = await waitFor(() => screen.getByRole("tab", { name: "Design" }));
    expect(design.getAttribute("aria-selected")).toBe("true");
    expect(messageCard().hidden).toBe(true);
  });

  it("opens on the Message section when a link asked for it", async () => {
    loadCustomisation();
    render(() => (
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        weddingName="Anita & Ben"
        canManage
        entitlements={[]}
        initialSection="invite-message"
      />
    ));

    const message = await waitFor(() => screen.getByRole("tab", { name: "Message" }));
    expect(message.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Design" }).getAttribute("aria-selected")).toBe("false");
    expect(messageCard().hidden).toBe(false);
  });

  it("shows the invite-message links once, inside the Message section", async () => {
    loadCustomisation();
    render(() => (
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        weddingName="Anita & Ben"
        canManage
        entitlements={[]}
        inviteMessageLinks={<p data-testid="invite-message-links" />}
      />
    ));

    await waitFor(() => expect(messageCard()).toBeTruthy());
    const links = screen.getAllByTestId("invite-message-links");
    expect(links).toHaveLength(1);
    expect(messageCard().contains(links[0]!)).toBe(true);
  });
  it("puts the copy action in the Message section, between the line and the links", async () => {
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

  it("reads the households only once the Message section is shown, and once per builder", async () => {
    answerReads();
    render(() => (
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        weddingName="Anita & Ben"
        canManage
        entitlements={[]}
      />
    ));
    const message = await waitFor(() => screen.getByRole("tab", { name: "Message" }));
    expect(householdReads()).toBe(0);

    fireEvent.click(message);
    await waitFor(() => expect(picker().options.length).toBe(2));
    fireEvent.change(picker(), { target: { value: "fam_a" } });

    // Away and back: no second read, and the household is still chosen.
    fireEvent.click(screen.getByRole("tab", { name: "Design" }));
    fireEvent.click(screen.getByRole("tab", { name: "Message" }));
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
    expect(copyButton().disabled).toBe(true);
    expect(screen.getByText("Save the invite to copy the new first line.")).toBeTruthy();

    fireEvent.input(lineField(), { target: { value: "Come to Goa!" } });
    expect(copyButton().disabled).toBe(false);
    fireEvent.click(copyButton());

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [line, link, code] = writeText.mock.calls[0]![0].split("\n");
    expect(line).toBe("Come to Goa!");
    expect(link).toMatch(/\/anita-ben$/);
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
    expect(copyButton().disabled).toBe(true);
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(copyButton().disabled).toBe(false));
    fireEvent.click(copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0].split("\n")[0]).toBe("Come to Goa, bring sunscreen!");
  });

  it("marks the household sent for the owner, and not for a co-host editor", async () => {
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const marks = () =>
      authFetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/mark-shared")).length;

    for (const [canManage, expected] of [
      [false, 0],
      [true, 1],
    ] as const) {
      answerReads();
      renderOnMessage(canManage);
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

    expect(copyButton().disabled).toBe(false);
    expect(screen.getByTestId("invite-message-preview").textContent).toMatch(
      /^You're invited to Anita & Ben!/,
    );
  });
});
