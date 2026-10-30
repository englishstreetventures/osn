// @vitest-environment happy-dom
import { ORGANISER_EMAIL_ATTESTATION } from "@cire/guest-email";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmailAttestationCheck from "../../src/components/EmailAttestationCheck";

/**
 * The organiser's attestation for the addresses a change adds: the box is named
 * by the words it attests and nothing else, the notice to share sits outside
 * the label and describes the box, and the count reads as English.
 */

afterEach(cleanup);

describe("EmailAttestationCheck", () => {
  it("names the box by the attestation alone and describes it by the notice to share", () => {
    const onChange = vi.fn();
    render(() => <EmailAttestationCheck count={3} checked={false} onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: ORGANISER_EMAIL_ATTESTATION.text });
    expect(box).toHaveAccessibleDescription(
      "The notice to share: cireweddings.com/privacy/guests (opens in a new tab)",
    );
    const link = screen.getByRole("link", { name: /cireweddings\.com\/privacy\/guests/ });
    expect(link.getAttribute("href")).toMatch(/\/privacy\/guests$/);
    expect(box.closest("label")).not.toContainElement(link);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("counts one address and several", () => {
    const { unmount } = render(() => (
      <EmailAttestationCheck count={1} checked={false} onChange={() => {}} />
    ));
    expect(screen.getByText("1 email address")).toBeInTheDocument();
    unmount();
    render(() => <EmailAttestationCheck count={3} checked={false} onChange={() => {}} />);
    expect(screen.getByText("3 email addresses")).toBeInTheDocument();
  });
});
