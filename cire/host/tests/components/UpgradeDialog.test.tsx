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
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    redirectToLogin,
    navigateTo,
  };
});
vi.mock("../../src/lib/haptics", () => ({ haptic: vi.fn() }));

import UpgradeDialog from "../../src/components/UpgradeDialog";
import { __resetUpgradeStore } from "../../src/lib/upgrade-store";

/**
 * The dialog that takes money.
 *
 * What is load-bearing here:
 *   - it never claims an unlock. Pressing the button leaves for Stripe; the
 *     tier is raised by webhook, and the portal finds out on return;
 *   - a `processing` refusal tells the organiser to WAIT. Inviting a second
 *     payment there is how somebody gets charged twice;
 *   - a tier the catalogue does not offer gets no button at all rather than
 *     one that 404s.
 */

const PROPS = {
  open: true,
  weddingId: "wed_1",
  tier: "gold",
  module: "registry",
  title: "Gold",
  blurb: "List the gifts you'd like.",
  onClose: vi.fn(),
} as const;

/** The catalogue response, as the API returns it, for a wedding on `tier`. */
function catalogue(entries: unknown[], tier = "ivory") {
  return new Response(JSON.stringify({ tier, upgrades: entries }), { status: 200 });
}

const GOLD = {
  tier: "gold",
  fromTier: "ivory",
  title: "Gold tier",
  blurb: "Your budget, checklist and gift registry, for up to 500 guests.",
  amountMinor: 2900,
  currency: "AUD",
};

const CRIMSON_FROM_GOLD = {
  tier: "crimson",
  fromTier: "gold",
  title: "Crimson tier",
  blurb: "Everything in Gold, plus vendors.",
  amountMinor: 3000,
  currency: "AUD",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpgradeStore();
});
afterEach(cleanup);

describe("pricing", () => {
  it("shows the price the API returned, not one baked into the app", async () => {
    authFetch.mockResolvedValueOnce(catalogue([GOLD]));
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

    expect(screen.getByText("Gold")).toBeInTheDocument();
    expect(screen.getByText(/checking the price/i)).toBeInTheDocument();

    release(catalogue([GOLD]));
    expect(await screen.findByText(/\$29\.00/)).toBeInTheDocument();
  });

  it("shows the tier's own copy from the catalogue once it lands", async () => {
    authFetch.mockResolvedValueOnce(catalogue([GOLD]));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText("Gold tier")).toBeInTheDocument();
    expect(screen.getByText(/for up to 500 guests/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Upgrade: Gold tier" })).toBeInTheDocument();
    // From Ivory, the eyebrow is plain: there is no paid tier to upgrade from.
    expect(screen.getByText("Upgrade")).toBeInTheDocument();
  });

  it("offers no purchase for a tier the deployment does not sell", async () => {
    // A catalogue that came back WITHOUT this tier: no Stripe Price configured,
    // or no Stripe at all. A button here would 404 on press.
    authFetch.mockResolvedValueOnce(catalogue([]));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/not available on this site yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("offers no purchase when the deployment has no upgrade routes at all", async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 404 }));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/not available on this site yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("says so rather than offering a second sale when the wedding is already on the tier", async () => {
    // The nav row locks by the wedding list and this by the catalogue; after a
    // purchase settles they can disagree for a render.
    authFetch.mockResolvedValueOnce(catalogue([], "gold"));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/already on Gold/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("counts a higher tier as holding a lower one", async () => {
    authFetch.mockResolvedValueOnce(catalogue([], "crimson"));
    render(() => <UpgradeDialog {...PROPS} />);

    expect(await screen.findByText(/already on Gold/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("prices Crimson for a Gold wedding as the upgrade from Gold", async () => {
    authFetch.mockResolvedValueOnce(catalogue([CRIMSON_FROM_GOLD], "gold"));
    render(() => <UpgradeDialog {...PROPS} tier="crimson" module="vendors" title="Crimson" />);

    expect(await screen.findByText(/\$30\.00/)).toBeInTheDocument();
    // Said where the price is, so the smaller figure is not read as Crimson's
    // full price.
    expect(screen.getByText("Upgrade from Gold")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeEnabled();
  });

  it("offers nothing to a Gold wedding when the deployment has no upgrade-from-Gold price", async () => {
    // The API leaves Crimson out of a Gold wedding's catalogue rather than
    // charging the full price again.
    authFetch.mockResolvedValueOnce(catalogue([], "gold"));
    render(() => <UpgradeDialog {...PROPS} tier="crimson" module="vendors" title="Crimson" />);

    expect(await screen.findByText(/not available on this site yet/i)).toBeInTheDocument();
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
    authFetch.mockResolvedValueOnce(catalogue([GOLD]));
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
    // It asked for the tier, and named the module to come back to.
    const [, init] = authFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ tier: "gold", module: "registry" });
    // Nothing was claimed unlocked: the tier is raised by webhook.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("names the tier when the API says the wedding already holds it", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "already_held" }), { status: 409 }),
    );

    fireEvent.click(button);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls[0]?.[0])).toMatch(/already on Gold/);
    expect(navigateTo).not.toHaveBeenCalled();
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
    // Closed first: a modal makes the page behind it inert, toaster included,
    // so a toast raised while it is open is painted and never announced.
    expect(PROPS.onClose.mock.invocationCallOrder[0]).toBeLessThan(
      toastInfo.mock.invocationCallOrder[0]!,
    );
  });

  it("reports an ordinary failure without leaving the page", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "payment_provider_unavailable" }), { status: 502 }),
    );

    fireEvent.click(button);
    // Said inside the dialog: the dialog stays open, and the page behind it,
    // toaster included, is inert while it does.
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start checkout/i);
    expect(toastError).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
    // Still offering the button: a 502 is Stripe's problem and may pass.
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeEnabled();
  });

  it("clears the failure when the organiser tries again", async () => {
    const button = await opened();
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "payment_provider_unavailable" }), { status: 502 }),
    );
    fireEvent.click(button);
    await screen.findByRole("alert");

    authFetch.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));
    expect(screen.queryByRole("alert")).toBeNull();
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
    authFetch.mockResolvedValueOnce(catalogue([GOLD]));
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
