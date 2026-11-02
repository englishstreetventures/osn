// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The builder's envelope picker, through what it refuses: an API too old to
 * send an envelope hides it, and a wedding that may not use premium envelopes
 * gets a lock no click or key gets past — including one that learns it only
 * from the save's 403. A save the server refuses leaves the choice unmoved, and
 * one that finds the session expired sends the organiser to sign in. Picking,
 * keeping and clearing an envelope are the `cire-checklist-holders` E2E flow's,
 * against the real API.
 */

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
import { authFetchMock, redirectSpy, resetOrganiserMocks, toastError } from "../test-support/mocks";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answers every builder read with the customisation plus `extra`, and each
 *  envelope save with `save` (none expected when it is left out). */
function answer(extra: Record<string, unknown>, save?: () => Response | Promise<Response>) {
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && url.endsWith("/invite/envelope")) {
      if (!save) throw new Error("no envelope save expected");
      return save();
    }
    return json({ ...CUSTOMISATION, ...extra });
  });
}

const envelopeSaves = () =>
  authFetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/invite/envelope")).length;

function renderBuilder() {
  render(() => (
    <InviteBuilder
      weddingId="wed_1"
      weddingSlug="anita-ben"
      weddingName="Anita & Ben"
      canEdit
      entitlements={[]}
    />
  ));
}

const envelopeGroup = () => screen.queryByRole("radiogroup", { name: "Invite envelope" });

async function findCard(name: RegExp): Promise<HTMLElement> {
  const group = await screen.findByRole("radiogroup", { name: "Invite envelope" });
  return within(group).getByRole("radio", { name });
}

describe("InviteBuilder envelope picker, refusals", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("is hidden when the invite read carries no envelopeId, as an API older than envelopes sends", async () => {
    answer({});
    renderBuilder();
    await screen.findByRole("radiogroup", { name: "Invite design" });
    expect(envelopeGroup()).toBeNull();

    // The same read with the key present shows it, so the absence above is
    // the missing key's doing.
    cleanup();
    resetOrganiserMocks();
    answer({ envelopeId: null, envelopeEntitled: true });
    renderBuilder();
    expect(await screen.findByRole("radiogroup", { name: "Invite envelope" })).toBeTruthy();
  });

  it("locks the Wax seal when the wedding may not use premium envelopes, and a click saves nothing", async () => {
    answer({ envelopeId: null, envelopeEntitled: false });
    renderBuilder();
    const seal = await findCard(/Wax seal/);
    expect(seal.getAttribute("aria-disabled")).toBe("true");
    expect(seal.textContent).toContain("Locked");
    // Nothing stored, so nothing is switched off, and the tab stop is None's.
    expect(screen.queryByText(/is switched off/)).toBeNull();
    expect((await findCard(/None/)).tabIndex).toBe(0);
    expect(seal.tabIndex).toBe(-1);

    fireEvent.click(seal);
    expect(envelopeSaves()).toBe(0);
  });

  it.each(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "End"])(
    "%s from None moves focus onto the locked Wax seal and saves nothing",
    async (key) => {
      answer({ envelopeId: null, envelopeEntitled: false });
      renderBuilder();
      const none = await findCard(/None/);
      const seal = await findCard(/Wax seal/);

      // The group takes the key (no page scroll), and the tab stop follows
      // focus onto the locked card while the choice stays None.
      expect(fireEvent.keyDown(none, { key })).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(seal));
      expect(seal.tabIndex).toBe(0);
      expect(none.tabIndex).toBe(-1);
      expect(none.getAttribute("aria-checked")).toBe("true");
      expect(envelopeSaves()).toBe(0);
    },
  );

  it("leaves Enter and Space on the locked card to the button, which chooses nothing", async () => {
    answer({ envelopeId: null, envelopeEntitled: false });
    renderBuilder();
    const seal = await findCard(/Wax seal/);
    for (const key of ["Enter", " "]) {
      expect(fireEvent.keyDown(seal, { key })).toBe(true);
    }
    expect(envelopeSaves()).toBe(0);
  });

  it("shows a stored envelope the wedding may no longer use as chosen but switched off", async () => {
    answer({ envelopeId: "wax-seal", envelopeEntitled: false });
    renderBuilder();
    const seal = await findCard(/Wax seal/);
    expect(seal.getAttribute("aria-checked")).toBe("true");
    expect(seal.getAttribute("aria-disabled")).toBe("true");
    expect(seal.textContent).toContain("Switched off");
    expect(seal.textContent).not.toContain("Current");
    expect(seal.tabIndex).toBe(0);
    expect((await findCard(/None/)).tabIndex).toBe(-1);
    expect(screen.getByText(/Your Wax seal is switched off/)).toBeTruthy();

    fireEvent.click(seal);
    expect(envelopeSaves()).toBe(0);
  });

  it("refuses a second save while one is in flight, and locks the card when the save answers 403 premium_envelope", async () => {
    let answerSave: (response: Response) => void = () => {};
    answer(
      { envelopeId: null, envelopeEntitled: true },
      () =>
        new Promise<Response>((resolve) => {
          answerSave = resolve;
        }),
    );
    renderBuilder();
    const seal = await findCard(/Wax seal/);
    const none = await findCard(/None/);

    fireEvent.click(seal);
    expect(envelopeSaves()).toBe(1);
    await waitFor(() => expect(none.getAttribute("aria-disabled")).toBe("true"));
    expect(seal.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(seal);
    expect(envelopeSaves()).toBe(1);

    answerSave(json({ error: "premium_envelope" }, 403));
    await waitFor(() => expect(seal.textContent).toContain("Locked"));
    expect(seal.getAttribute("aria-disabled")).toBe("true");
    expect(seal.getAttribute("aria-checked")).toBe("false");
    expect(none.getAttribute("aria-disabled")).toBeNull();
    expect(toastError).toHaveBeenCalledWith("Could not update the envelope");

    fireEvent.click(seal);
    expect(envelopeSaves()).toBe(1);
  });

  it("leaves the choice and the card as they were when the save is refused for another reason", async () => {
    answer({ envelopeId: null, envelopeEntitled: true }, () =>
      json({ error: "Unknown envelope" }, 422),
    );
    renderBuilder();
    const seal = await findCard(/Wax seal/);

    fireEvent.click(seal);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not update the envelope"));
    expect((await findCard(/None/)).getAttribute("aria-checked")).toBe("true");
    expect(seal.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(seal.getAttribute("aria-disabled")).toBeNull());
    expect(seal.textContent).not.toContain("Locked");
    // The tab stop stays on the card the organiser clicked.
    expect(seal.tabIndex).toBe(0);
  });

  it("sends the organiser to sign in, with no error toast, when the save finds the session expired", async () => {
    answer({ envelopeId: null, envelopeEntitled: true }, () => {
      throw new Error("AuthExpiredError");
    });
    renderBuilder();
    const seal = await findCard(/Wax seal/);

    fireEvent.click(seal);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(seal.getAttribute("aria-checked")).toBe("false");
  });
});
