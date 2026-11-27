// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The removal screen's answers and its removal loop: what no E2E flow can
 * afford to reach (a host with enough weddings to meet the limiter, or a
 * failure part way), and an answer outliving the plan it answered.
 *
 * 1. A 429 between rounds is waited out, 60 s, and the removal carries on to
 *    the end: `onDone` once, after three calls.
 * 2. A failure after a round says part is done ("Part of your data is removed
 *    already.") and reads the plan again.
 * 3. "Delete every wedding only you own" never applies to a plan that hides
 *    it: kept from an earlier visit, or carried in memory past a failure that
 *    left one such wedding, it is dropped, and that wedding's box is the
 *    person's to tick.
 * 4. A removal cire-api could not record (503 `deletion_not_recorded`, nothing
 *    erased) asks the person to try again; it is not Musubi out of reach. A 503
 *    `unavailable`, osn-api out of reach, still says so.
 */

const { authFetch, haptic } = vi.hoisted(() => ({ authFetch: vi.fn(), haptic: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
  navigateTo: () => {},
}));
vi.mock("../../src/lib/touch-feedback", () => ({ haptic }));

import RemoveCireData from "../../src/components/RemoveCireData";
import type { RemovalPlan, RemovalWedding } from "../../src/lib/account-removal";
import { forgetRemoval, keepAnswers, keptAnswers } from "../../src/lib/account-removal";

const sole = (weddingId: string, name: string): RemovalWedding => ({
  weddingId,
  name,
  role: "owner",
  soleOwner: true,
  deleted: false,
});
const MIA: RemovalWedding = {
  weddingId: "wed_mia",
  name: "Mia & Theo",
  role: "owner",
  soleOwner: false,
  deleted: false,
};
const plan = (owned: RemovalWedding[], confirmed: boolean): RemovalPlan => ({
  weddings: [MIA, ...owned],
  more: 0,
  openActions: owned.map((w) => ({ id: `cire:wedding:${w.weddingId}`, weddingId: w.weddingId })),
  confirmed,
});

const ROSA = sole("wed_rosa", "Rosa & Viktor");
const FOUR = [
  ROSA,
  sole("wed_kai", "Kai & Noor"),
  sole("wed_ana", "Ana & Ben"),
  sole("wed_jo", "Jo & Lee"),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answers the preview from `previews` in turn (the last one again after), and each removal call in turn. */
function serve(previews: RemovalPlan[], removals: Response[]) {
  const calls = { preview: 0, remove: 0 };
  authFetch.mockImplementation(async (input: unknown) => {
    const path = String(input).replace("https://api.test", "");
    if (path === "/api/organiser/account/removal/preview") {
      const next = previews[Math.min(calls.preview, previews.length - 1)]!;
      calls.preview += 1;
      return json(next);
    }
    if (path === "/api/organiser/account") {
      const next = removals[calls.remove];
      calls.remove += 1;
      return next ?? new Promise<Response>(() => {});
    }
    return json({});
  });
  return calls;
}

function show(props: { code?: string; onDone?: () => void } = {}) {
  render(() => (
    <RemoveCireData
      code={props.code}
      canOpen={() => true}
      onOpen={() => {}}
      onCancel={() => {}}
      onDone={props.onDone ?? (() => {})}
    />
  ));
}

/** Lets every answer already given run its course, with the clock held. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
}

const everythingBox = () =>
  screen.queryByRole("checkbox", { name: /Delete every wedding only you own/ });
const boxOf = (wedding: RemovalWedding) =>
  screen.getByRole<HTMLInputElement>("checkbox", { name: `Delete this wedding: ${wedding.name}` });

beforeEach(() => {
  forgetRemoval();
  authFetch.mockReset();
  haptic.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  forgetRemoval();
});

describe("RemoveCireData's removal loop", () => {
  it("waits out a 429 between rounds, then finishes", async () => {
    const onDone = vi.fn();
    const calls = serve(
      [plan(FOUR, true)],
      [
        json({ status: "not_finished" }, 202),
        json({ error: "Too many requests" }, 429),
        json({ status: "done" }),
      ],
    );
    show({ code: "code_ok", onDone });
    expect(await screen.findByText(ROSA.name)).toBeTruthy();
    fireEvent.click(everythingBox()!);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    await settle();
    expect(calls.remove).toBe(2);
    expect(screen.getByText("Waiting a minute before the next part…")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls.remove).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(calls.remove).toBe(3);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("says part is done after a failure past a round, and reads the plan again", async () => {
    // The first round took three weddings; one is left, so the plan read
    // again no longer offers "Delete every wedding only you own".
    const calls = serve(
      [plan(FOUR, true), plan([ROSA], true)],
      [json({ status: "not_finished" }, 202), json({ error: "Internal error" }, 500)],
    );
    show({ code: "code_ok" });
    expect(await screen.findByText(ROSA.name)).toBeTruthy();
    fireEvent.click(everythingBox()!);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    await settle();
    expect(calls.remove).toBe(2);
    expect(calls.preview).toBe(2);
    // The line starts with it, after the notice's hidden "Error".
    expect(screen.getByText(/^Part of your data is removed already\./)).toBeTruthy();

    expect(everythingBox()).toBeNull();
    expect(boxOf(ROSA).checked).toBe(false);
    expect(boxOf(ROSA).disabled).toBe(false);
    expect(keptAnswers()?.deleteEverything).toBe(false);
  });

  it("asks to try again when the removal could not be recorded, not that Musubi is unreachable", async () => {
    serve([plan([ROSA], true)], [json({ error: "deletion_not_recorded" }, 503)]);
    show({ code: "code_ok" });
    expect(await screen.findByText(ROSA.name)).toBeTruthy();
    fireEvent.click(boxOf(ROSA));
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    expect(await screen.findByText(/Cire couldn't finish this\. Try again\./)).toBeTruthy();
    expect(screen.queryByText(/Cire can't reach Musubi/)).toBeNull();
  });

  it("says Musubi is out of reach when the removal answers 503 unavailable", async () => {
    serve([plan([ROSA], true)], [json({ error: "unavailable" }, 503)]);
    show({ code: "code_ok" });
    expect(await screen.findByText(ROSA.name)).toBeTruthy();
    fireEvent.click(boxOf(ROSA));
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    expect(await screen.findByText(/Cire can't reach Musubi right now\./)).toBeTruthy();
  });
});

describe("RemoveCireData and a wedding's payout account", () => {
  /** Mia & Theo, which the person owns with someone else, and whose Stripe account they hold. */
  const HELD: RemovalWedding = { ...MIA, payoutHolder: true };
  const heldPlan = (confirmed: boolean): RemovalPlan => ({
    weddings: [HELD],
    more: 0,
    openActions: [],
    confirmed,
  });
  const note = /You connected the Stripe account money gifts are paid into/;

  it("still removes on a confirmed list naming a payout account the person holds when the API agrees", async () => {
    // The list's mark can be stale: the removal is sent, and the API decides.
    const onDone = vi.fn();
    const calls = serve([heldPlan(true)], [json({ status: "done" })]);
    show({ code: "code_ok", onDone });
    expect(await screen.findByText(note)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(calls.remove).toBe(1);
    expect(screen.queryByText("Hand this over before you remove your data.")).toBeNull();
  });

  it("lets the person go on to Musubi from the first step, whose list holds only one profile", async () => {
    // Before confirmation the list is the signed-in profile's alone, and
    // another profile of the same account may be the other owner.
    serve([heldPlan(false)], []);
    show();
    expect(await screen.findByText(note)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm on Musubi" }));
    await waitFor(() =>
      expect(
        authFetch.mock.calls.some(([url]) =>
          String(url).endsWith("/api/organiser/account/removal/confirmation"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("Hand this over before you remove your data.")).toBeNull();
  });

  it("shows the refusal's own words when the removal finds a payout account the list did not", async () => {
    const message =
      "You connected the Stripe account that money gifts are paid into on the weddings listed. Hand it over, then remove your data again.";
    serve(
      [plan([], true), heldPlan(true)],
      [
        json(
          {
            error: "holds_payout_account",
            message,
            weddings: [{ weddingId: MIA.weddingId, name: MIA.name }],
          },
          409,
        ),
      ],
    );
    show({ code: "code_ok" });
    expect(await screen.findByText(MIA.name)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    expect(await screen.findByText(message)).toBeTruthy();
    // The list is read again, and the wedding says why, is marked, and its
    // way to Money gifts takes focus.
    expect(await screen.findByText(note)).toBeTruthy();
    expect(await screen.findByText("Hand this over before you remove your data.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Money gifts"));
  });

  it("says part is done when the refusal comes after a round", async () => {
    const message = "Hand money gifts over first, then remove your data again.";
    serve(
      [plan(FOUR, true), heldPlan(true)],
      [
        json({ status: "not_finished" }, 202),
        json({ error: "holds_payout_account", message, weddings: [] }, 409),
      ],
    );
    show({ code: "code_ok" });
    expect(await screen.findByText(ROSA.name)).toBeTruthy();
    fireEvent.click(everythingBox()!);
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    expect(
      await screen.findByText(`Part of your data is removed already. ${message}`),
    ).toBeTruthy();
  });

  it("links the wedding's Money gifts through the dashboard, where its tier opens them", async () => {
    serve([heldPlan(true)], []);
    const onOpen = vi.fn();
    const { unmount } = render(() => (
      <RemoveCireData
        code="code_ok"
        canOpen={() => true}
        onOpen={onOpen}
        onCancel={() => {}}
        onDone={() => {}}
      />
    ));
    const link = await screen.findByRole("link", { name: "Money gifts" });
    expect(link.getAttribute("href")).toBe(`#/w/${MIA.weddingId}/registry/settings`);
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith(MIA.weddingId, "money");
    unmount();

    // Below the tier that opens the registry, the words stand alone.
    serve([heldPlan(true)], []);
    render(() => (
      <RemoveCireData
        code="code_ok"
        canOpen={() => true}
        canOpenMoney={() => false}
        onOpen={onOpen}
        onCancel={() => {}}
        onDone={() => {}}
      />
    ));
    expect(await screen.findByText(note)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Money gifts" })).toBeNull();
  });

  it("sends the person to the profile that holds a seat this session cannot open", async () => {
    serve([heldPlan(true)], []);
    render(() => (
      <RemoveCireData
        code="code_ok"
        canOpen={() => false}
        onOpen={() => {}}
        onCancel={() => {}}
        onDone={() => {}}
      />
    ));
    expect(
      await screen.findByText(
        /To hand it over, sign in to Cire with the profile that holds this seat\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Money gifts" })).toBeNull();
  });

  it("says where to hand the account over when the refusal brings no words of its own", async () => {
    serve([plan([], true), heldPlan(true)], [json({ error: "holds_payout_account" }, 409)]);
    show({ code: "code_ok" });
    expect(await screen.findByText(MIA.name)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove my Cire data" }));
    expect(
      await screen.findByText(
        /disconnect it in that wedding's Money gifts, then remove your data again\.$/,
      ),
    ).toBeTruthy();
  });
});

describe("RemoveCireData's answers", () => {
  it("drops a kept 'delete every wedding' answer on a plan that does not offer it", async () => {
    keepAnswers({ answered: [], deleteEverything: true });
    serve([plan([ROSA], false)], []);
    show();
    expect(await screen.findByText(ROSA.name)).toBeTruthy();

    expect(everythingBox()).toBeNull();
    expect(boxOf(ROSA).checked).toBe(false);
    expect(boxOf(ROSA).disabled).toBe(false);
    expect(keptAnswers()?.deleteEverything).toBe(false);
  });
});
