import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../../src/styles/global.css";

/**
 * The composed-message preview at the 320px Reflow floor. Its link carries the
 * wedding's slug and its last line a household's code, and neither has a space
 * to break at, so only a real engine can say whether the preview wraps them or
 * pushes the builder's card sideways on a phone.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../../src/lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import InviteMessageCopy from "../../../src/components/invite/InviteMessageCopy";

const LONG_SLUG = "anitaandbenjamincelebratetheirweddingintheblueMountains-9f3k2";
const LONG_CODE = "WOLFESCHLEGELSTEINHAUSEN-WIDGET-AB3K9-X7QPM-Z2Y8N";

describe("the invite-message preview", () => {
  afterEach(() => {
    cleanup();
    authFetch.mockReset();
  });

  it("wraps an unbroken link and code inside its card at 320px", async () => {
    await page.viewport(320, 700);
    authFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            familyId: "fam_a",
            publicId: LONG_CODE,
            familyName: "Wolfeschlegelsteinhausen",
            guestCount: 2,
            codeSharedAt: null,
            firstOpenedAt: null,
            deactivatedAt: null,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(() => (
      <div data-testid="card" style={{ width: "288px", padding: "16px" }}>
        <InviteMessageCopy
          weddingId="wed_1"
          weddingName="Anita & Ben"
          weddingSlug={LONG_SLUG}
          canManage
          savedLine={null}
          draftLine=""
        />
      </div>
    ));
    const picker = (await waitFor(() => {
      const select = screen.getByLabelText("Household") as HTMLSelectElement;
      expect(select.options.length).toBe(2);
      return select;
    })) as HTMLSelectElement;
    picker.value = "fam_a";
    picker.dispatchEvent(new Event("change", { bubbles: true }));

    const preview = screen.getByTestId("invite-message-preview");
    await waitFor(() => expect(preview.textContent).toContain(LONG_CODE));
    expect(preview.textContent).toContain(LONG_SLUG);

    const card = screen.getByTestId("card").getBoundingClientRect();
    const box = preview.getBoundingClientRect();
    expect(preview.scrollWidth).toBeLessThanOrEqual(preview.clientWidth);
    expect(box.right).toBeLessThanOrEqual(card.right + 0.5);
  });
});
