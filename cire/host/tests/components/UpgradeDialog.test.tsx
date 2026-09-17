// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not plain consts: ESM lifts the component import above every
// declaration in this file, so a mock factory closing over a bare `const` reads
// it in its temporal dead zone.
const { authFetch, toastError, toastInfo, toastSuccess, redirectToLogin, navigateTo } = vi.hoisted(
  () => ({
    authFetch: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    toastSuccess: vi.fn(),
    redirectToLogin: vi.fn(),
    navigateTo: vi.fn(),
  }),
);

vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({
  toast: { success: toastSuccess, error: toastError, info: toastInfo },
}));
vi.mock("../../src/lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  redirectToLogin,
  navigateTo,
}));
vi.mock("../../src/lib/haptics", () => ({ haptic: vi.fn() }));

import UpgradeDialog from "../../src/components/UpgradeDialog";
import { __resetUpgradeStore } from "../../src/lib/upgrade-store";

/**
 * The dialog that takes money.
 *
 * What is load-bearing here:
 *   - it never claims an unlock. Pressing the button leaves for Stripe; the
 *     entitlement arrives by webhook, and the portal finds out on return;
 *   - a `processing` refusal tells the organiser to WAIT. Inviting a second
 *     payment there is how somebody gets charged twice;
 *   - an unpriced key offers no button at all rather than one that 404s.
 */

const PROPS = {
  open: true,
  weddingId: "wed_1",
  entitlement: "registry",
  title: "Gift registry",
  blurb: "List the gifts you'd like.",
  onClose: vi.fn(),
};

/** The catalogue response, as the API returns it. */
function catalogue(entries: unknown[]) {
  return new Response(JSON.stringify({ upgrades: entries }), { status: 200 });
}

const REGISTRY = {
  entitlement: "registry",
  title: "Gift registry",
  blurb: "List the gifts you'd like, and see what guests have claimed.",
  amountMinor: 2900,
  currency: "AUD",
  held: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpgradeStore();
});
afterEach(cleanup);

describe("pricing", () => {
  it("shows the price the API returned, not one baked into the app", async () => {
    authFetch.mockResolvedValueOnce(catalogue([REGISTRY]));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/\$29\.00/)).toBeInTheDocument();
    // And it read the catalogue rather than assuming.
    expect(authFetch).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_1/upgrade/catalogue",
    );
  });

  it("falls back to the nav row's copy while the price is loading", async () => {
    // A deferred rather than a never-settling promise: one that never resolves
    // keeps the module environment alive and hangs the run at teardown.
    let release!: (r: Response) => void;
    authFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    render(() => <UpgradeDialog {...PROPS} />);

    expect(screen.getByText("Gift registry")).toBeInTheDocument();
    expect(screen.getByText(/checking the price/i)).toBeInTheDocument();

    release(catalogue([REGISTRY]));
    expect(await screen.findByText(/\$29\.00/)).toBeInTheDocument();
  });

  it("offers no purchase for a key the deployment does not sell", async () => {
    // A catalogue that came back WITHOUT this key: no Stripe Price configured,
    // or no Stripe at all. A button here would 404 on press.
    authFetch.mockResolvedValueOnce(catalogue([]));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/not available on this site yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("says so rather than offering a second sale when the key is already held", async () => {
    authFetch.mockResolvedValueOnce(catalogue([{ ...REGISTRY, held: true }]));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/you already have this/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("survives a catalogue that will not load", async () => {
    authFetch.mockRejectedValueOnce(new Error("offline"));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/could not load the price/i)).toBeInTheDocument();
  });
});

describe("paying", () => {
  async function opened() {
    authFetch.mockResolvedValueOnce(catalogue([REGISTRY]));
    render(() => <UpgradeDialog {...PROPS} />);
    await screen.findByText(/\$29\.00/);
    return screen.getByRole("button", { name: /continue to payment/i });
  }

  it("sends the organiser to the Stripe page the API returned", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ purchaseId: "upg_1", url: "https://pay.test/cs_1" }), {
        status: 200,
      }),
    );

    fireEvent.click(button);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("https://pay.test/cs_1"));
    // Nothing was claimed unlocked: the entitlement arrives by webhook.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  /**
   * THE DOUBLE-CHARGE GUARD, on the client side of it. The API refuses with
   * `processing` when an earlier session is paid but not settled. Telling the
   * organiser to try again here is exactly how somebody pays twice.
   */
  it("tells the organiser to wait when a payment is still being confirmed", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "processing" }), { status: 409 }),
    );

    fireEvent.click(button);
    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(String(toastInfo.mock.calls[0]?.[0])).toMatch(/still being confirmed/i);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports an ordinary failure without leaving the page", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "payment_provider_unavailable" }), { status: 502 }),
    );

    fireEvent.click(button);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(navigateTo).not.toHaveBeenCalled();
    // Still offering the button: a 502 is Stripe's problem and may pass.
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeEnabled();
  });

  it("bounces to sign-in on an expired session", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 401 }));

    fireEvent.click(button);
    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("closes on Cancel without asking the API for anything", async () => {
    const onClose = vi.fn();
    authFetch.mockResolvedValueOnce(catalogue([REGISTRY]));
    render(() => <UpgradeDialog {...PROPS} onClose={onClose} />);
    await screen.findByText(/\$29\.00/);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    // One call: the catalogue. Nothing was started.
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(() => <UpgradeDialog {...PROPS} open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
