// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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
