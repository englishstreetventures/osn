// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();

vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch }),
}));

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    redirectToLogin: vi.fn(),
  };
});

vi.mock("../../src/lib/enquiries-store", () => ({
  upsertCachedEnquiry: vi.fn(),
}));

beforeEach(() => {
  authFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

async function importComponent() {
  const { default: EnquireDialog } = await import("../../src/components/EnquireDialog");
  return EnquireDialog;
}

const baseProps = {
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  category: "florals",
  vendorName: "Blue Roses",
  onClose: vi.fn(),
};

describe("EnquireDialog", () => {
  it("on 401 error calls redirectToLogin", async () => {
    const EnquireDialog = await importComponent();
    const { redirectToLogin } = await import("../../src/lib/api");
    const onClose = vi.fn();

    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    render(() => <EnquireDialog {...baseProps} open={true} onClose={onClose} />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
