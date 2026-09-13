// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegistrySettingsView from "../../src/components/RegistrySettingsView";
import {
  __resetRegistryCache,
  peekCachedRegistry,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../../src/lib/registry-store";

/**
 * The registry's settings panel.
 *
 * What is load-bearing here:
 *   - publishing is blocked while the list is empty, and the panel says why —
 *     including that money gifts need a published list too;
 *   - the one owner-only control is visible to an editor, disabled, with the
 *     reason. A co-host who wonders why money gifts are off gets an answer;
 *   - "let guests give money" cannot be turned on until Stripe can actually
 *     take a charge, and the 409 that means the account changed under the page
 *     says the true thing rather than "check the fields";
 *   - empty copy is sent as `null`, never `""` — the guest surface reads null as
 *     "use the built-in default" and an empty string would beat it;
 *   - the live Stripe read happens for a couple MID-ONBOARDING and nobody else.
 */

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@shared/toast", () => ({
  toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}));

const item = (over: Partial<RegistryItem> = {}): RegistryItem =>
  ({
    id: "itm_1",
    weddingId: "wed_1",
    kind: "product",
    title: "Copper pan",
    description: null,
    imageKey: null,
    imageCrop: null,
    externalUrl: null,
    priceMinor: null,
    quantityWanted: 1,
    quantityClaimed: 0,
    allowPartial: false,
    targetMinor: null,
    category: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as RegistryItem;

const snapshot = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot =>
  ({
    settings: {
      weddingId: "wed_1",
      published: false,
      headline: null,
      message: null,
      cashGiftsEnabled: false,
      shippingAddress: null,
      shippingVisibleFrom: null,
      stripeAccountId: null,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      updatedAt: null,
      ...over.settings,
    },
    items: over.items ?? [],
    gifts: [],
    giftsHasMore: false,
    giftSummary: null,
    currency: "AUD",
    contributionsPrimaryMinor: 0,
    contributionsOtherCurrencyCount: 0,
  }) as RegistrySnapshot;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel(props: { canEdit?: boolean; canManage?: boolean } = {}) {
  return render(() => (
    <RegistrySettingsView
      weddingId="wed_1"
      canEdit={props.canEdit ?? true}
      canManage={props.canManage ?? true}
    />
  ));
}

/** The last body `authFetch` was given, parsed. */
function lastBody(): Record<string, unknown> {
  const call = authFetch.mock.calls.at(-1);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}")) as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetRegistryCache();
  authFetch.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe("publishing", () => {
  it("is blocked while the list is empty, and says why", async () => {
    setCachedRegistry("wed_1", snapshot());
    renderPanel();

    const publish = (await screen.findByTestId("registry-publish")) as HTMLInputElement;
    expect(publish.disabled).toBe(true);
    // The consequence a couple needs to know: money gifts live on the published
    // page too, so this is not only about the gift list.
    expect(screen.getByText(/money-gift option/i)).toBeTruthy();
    // And it is announced on entering the group rather than left as loose text
    // beside a control the keyboard skips.
    const group = publish.closest("fieldset") as HTMLFieldSetElement;
    expect(group.getAttribute("aria-describedby")).toBe("registry-publish-blocked");
    expect(document.getElementById("registry-publish-blocked")?.textContent).toMatch(
      /Add a gift before publishing/i,
    );
  });

  it("is allowed once there is a gift", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();

    const publish = (await screen.findByTestId("registry-publish")) as HTMLInputElement;
    expect(publish.disabled).toBe(false);
    expect(screen.queryByText(/Add a gift before publishing/i)).toBeNull();
    // The description goes with the notice — a dangling id describes nothing.
    expect(publish.closest("fieldset")?.getAttribute("aria-describedby")).toBeNull();
  });

  it("never traps a couple whose published list lost its last gift", async () => {
    // Publishing is blocked, but an ALREADY published list must stay
    // switchable — otherwise deleting the last gift would freeze the radio
    // group on "Published" with no way back to draft.
    setCachedRegistry("wed_1", snapshot({ settings: { published: true } as never }));
    renderPanel();

    const publish = (await screen.findByTestId("registry-publish")) as HTMLInputElement;
    expect(publish.disabled).toBe(false);
    expect(publish.checked).toBe(true);
  });
});

describe("what gets saved", () => {
  it("sends empty copy as null, not as an empty string", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    await screen.findByTestId("registry-publish");
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const body = lastBody();
    // The guest surface reads null as "use the built-in default"; "" would win
    // over it and render an empty heading.
    expect(body.headline).toBeNull();
    expect(body.message).toBeNull();
    expect(body.shippingAddress).toBeNull();
    expect(body.shippingVisibleFrom).toBeNull();
  });

  it("sends what the couple typed, trimmed", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(json({ settings: snapshot().settings }));
    const { container } = renderPanel();

    await screen.findByTestId("registry-publish");
    fireEvent.input(screen.getByLabelText(/Heading/i), { target: { value: "  Our list  " } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(lastBody().headline).toBe("Our list");
  });

  it("patches the shared snapshot rather than re-fetching the whole registry", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(
      json({ settings: { ...snapshot().settings, headline: "Our list", published: true } }),
    );
    const { container } = renderPanel();

    await screen.findByTestId("registry-publish");
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const cached = peekCachedRegistry("wed_1");
    expect(cached?.settings.headline).toBe("Our list");
    // The list is untouched — switching back to the gift list costs no fetch.
    expect(cached?.items).toHaveLength(1);
  });
});

describe("money gifts", () => {
  it("cannot be switched on until Stripe can take a charge", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: false } as never,
      }),
    );
    authFetch.mockResolvedValue(
      json({ connected: true, chargesEnabled: false, payoutsEnabled: false }),
    );
    renderPanel();

    const toggle = (await screen.findByTestId("cash-gifts")) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/Available once Stripe can take payments/i)).toBeTruthy();
  });

  it("is switchable once Stripe is ready", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();

    const toggle = (await screen.findByTestId("cash-gifts")) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
  });

  it("says the true thing when the account changed under the page", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ error: "stripe_not_ready" }, 409));
    const { container } = renderPanel();

    const toggle = (await screen.findByTestId("cash-gifts")) as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Not "check the fields" — nothing in the form is wrong.
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Stripe can’t take a payment/);
    // And the switch does not sit on, claiming something the server refused.
    expect((screen.getByTestId("cash-gifts") as HTMLInputElement).checked).toBe(false);
  });
});

describe("who may connect the account", () => {
  it("lets the owner start onboarding, and hands them to Stripe", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(json({ url: "https://connect.stripe.com/setup/s/x" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });

    renderPanel({ canManage: true });
    const button = await screen.findByRole("button", { name: /Connect an account/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.stripe.com/setup/s/x"),
    );
    const [url, init] = authFetch.mock.calls.at(-1) ?? [];
    expect(String(url)).toContain("/registry/stripe/session");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
  });

  it("goes to Stripe and nowhere else", async () => {
    // The response body decides where a signed-in owner's browser goes next, so
    // anything that is not Stripe's own onboarding host is refused rather than
    // navigated to.
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    authFetch.mockResolvedValue(json({ url: "https://connect.stripe.com.evil.test/setup" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });

    renderPanel({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /Connect an account/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows an editor the panel, disabled, with the reason", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel({ canEdit: true, canManage: false });

    const button = await screen.findByRole("button", { name: /Connect an account/i });
    // Visible, not hidden: a co-host who wonders why money gifts are off gets
    // an answer instead of a missing section.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("stripe-owner-only").textContent).toMatch(
      /only the wedding’s owner/i,
    );
    // And the reason is REACHABLE: `aria-disabled` rather than `disabled` keeps
    // the button in the tab order, and the description says whose job it is.
    expect(button.getAttribute("aria-describedby")).toBe("stripe-owner-only");
    expect(screen.getByTestId("stripe-owner-only").id).toBe("stripe-owner-only");
    // Focusable, but still inert — pressing it asks Stripe for nothing.
    fireEvent.click(button);
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe("the live Stripe read", () => {
  it("happens for a couple mid-onboarding", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: false } as never,
      }),
    );
    authFetch.mockResolvedValue(
      json({ connected: true, chargesEnabled: true, payoutsEnabled: true }),
    );
    renderPanel();

    // They have just come back from Stripe and the webhook may be seconds
    // behind them; this is the one state where asking is worth a call.
    await waitFor(() => {
      const urls = authFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/registry/stripe/refresh"))).toBe(true);
    });
    await waitFor(() =>
      expect((screen.getByTestId("cash-gifts") as HTMLInputElement).disabled).toBe(false),
    );
  });

  it("does not happen for a couple with no account, or one already ready", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();
    await screen.findByTestId("registry-publish");
    expect(authFetch).not.toHaveBeenCalled();

    cleanup();
    __resetRegistryCache();
    authFetch.mockReset();
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();
    await screen.findByTestId("registry-publish");
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe("what the panel says about the account", () => {
  it("asks a couple with no account to connect one, and offers nothing to re-check", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item()] }));
    renderPanel();

    expect((await screen.findByTestId("stripe-status")).textContent).toMatch(
      /connect a Stripe account/i,
    );
    expect(screen.getByRole("button", { name: /Connect an account/i })).toBeTruthy();
    // Nothing to check on yet, so the button that checks is not there to press.
    expect(screen.queryByRole("button", { name: /Check again/i })).toBeNull();
  });

  it("tells a couple mid-onboarding that Stripe is still waiting on them", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: false } as never,
      }),
    );
    // The mount read finds nothing has changed, so the panel stays where it was.
    authFetch.mockResolvedValue(json({ chargesEnabled: false, payoutsEnabled: false }));
    renderPanel();

    expect((await screen.findByTestId("stripe-status")).textContent).toMatch(
      /still wants something/i,
    );
    // Not "connect an account" — they have one, and sending them back to the
    // start would read as though the work they already did was lost.
    expect(screen.getByRole("button", { name: /Continue on Stripe/i })).toBeTruthy();
    // Awaited: the mount read is in flight on first paint, and the button reads
    // "Checking…" until it lands.
    expect(await screen.findByRole("button", { name: /Check again/i })).toBeTruthy();
  });

  it("tells a ready couple the money reaches them directly", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: true } as never,
      }),
    );
    renderPanel();

    const status = await screen.findByTestId("stripe-status");
    expect(status.textContent).toMatch(/connected and can take payments/i);
    expect(status.textContent).toMatch(/never hold the money/i);
    expect(screen.getByRole("button", { name: /Continue on Stripe/i })).toBeTruthy();
  });
});

describe("checking on Stripe by hand", () => {
  it("says so when Stripe cannot be reached, and changes nothing", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockResolvedValue(json({ error: "stripe_unavailable" }, 502));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Check again/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Couldn’t reach Stripe just now/);
    // An outage is not news about the account: the panel keeps saying what it
    // last knew rather than demoting a couple who can in fact take payments.
    expect(screen.getByTestId("stripe-status").textContent).toMatch(
      /connected and can take payments/i,
    );
    expect((screen.getByTestId("cash-gifts") as HTMLInputElement).disabled).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("re-reads Stripe after a save it refused, without a second complaint", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: true } as never,
      }),
    );
    authFetch.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/registry/stripe/refresh")
          ? json({ chargesEnabled: false, payoutsEnabled: false })
          : json({ error: "stripe_not_ready" }, 409),
      ),
    );
    const { container } = renderPanel();

    fireEvent.click(await screen.findByTestId("cash-gifts"));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    // The 409 says the page is out of date about Stripe, so the panel goes and
    // finds out rather than waiting for the couple to press anything.
    await waitFor(() => {
      const urls = authFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/registry/stripe/refresh"))).toBe(true);
    });
    await waitFor(() =>
      expect(screen.getByTestId("stripe-status").textContent).toMatch(/still wants something/i),
    );
    // One complaint, about the save. The read behind it is quiet: a second
    // toast saying Stripe is not ready tells them nothing they were not just
    // told, and a success toast would contradict the first.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("the one-shot live read", () => {
  it("is spent for good, so a couple switching tabs does not re-ask Stripe", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item()],
        settings: { stripeAccountId: "acct_1", stripeChargesEnabled: false } as never,
      }),
    );
    // Still not ready, so nothing about the wedding has changed between the two
    // mounts: only the spent token stops the second read.
    authFetch.mockResolvedValue(json({ chargesEnabled: false, payoutsEnabled: false }));

    renderPanel();
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    cleanup();
    renderPanel();
    await screen.findByTestId("registry-publish");
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
