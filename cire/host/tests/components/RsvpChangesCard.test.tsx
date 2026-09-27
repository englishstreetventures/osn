// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Overview's "RSVP changes since your last visit" card: a count, the latest
 * households by name, a way to the RSVP table, and — for the organisers the
 * digest goes to — their own daily email switch. It reads on its own, so a
 * failed read hides this card and nothing else.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import RsvpChangesCard from "../../src/components/RsvpChangesCard";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const FEED = {
  markSeq: 12,
  households: 2,
  truncated: false,
  items: [
    {
      familyId: "f1",
      familyName: "Sharma",
      kinds: ["reply_new", "plus_one_added"],
      at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    { familyId: "f2", familyName: "Jones", kinds: ["reply_edited"], at: new Date().toISOString() },
  ],
  rows: [{ guestId: "g1", eventId: "e1" }],
  digest: { available: true, enabled: true },
};

function routeFetch(feed: unknown, feedStatus = 200, digestStatus = 200) {
  authFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/rsvp-changes/digest")) {
      return Promise.resolve(
        json({ enabled: JSON.parse(String(init?.body)).enabled }, digestStatus),
      );
    }
    if (url.endsWith("/rsvp-changes")) return Promise.resolve(json(feed, feedStatus));
    return Promise.resolve(json({}, 404));
  });
}

describe("RsvpChangesCard", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("counts the households and names the latest with what they changed", async () => {
    routeFetch(FEED);
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    expect(await screen.findByText("RSVP changes since your last visit")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("households changed their RSVPs")).toBeInTheDocument();
    expect(screen.getByText("Sharma")).toBeInTheDocument();
    expect(screen.getByText(/replied, added a plus-one/)).toBeInTheDocument();
    expect(screen.getByText(/2 h ago/)).toBeInTheDocument();
    expect(screen.getByText("Jones")).toBeInTheDocument();
  });

  it("says when the count is a floor", async () => {
    routeFetch({ ...FEED, households: 500, truncated: true });
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    expect(await screen.findByText("500+")).toBeInTheDocument();
  });

  it("sends the organiser to the RSVP table", async () => {
    routeFetch(FEED);
    const onNavigate = vi.fn();
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole("button", { name: /See the RSVP table/ }));
    expect(onNavigate).toHaveBeenCalledWith("guests", "rsvps");
  });

  it("says plainly when nothing changed", async () => {
    routeFetch({ ...FEED, markSeq: 0, households: 0, items: [], rows: [] });
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    expect(await screen.findByText("Nothing new since your last visit.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /See the RSVP table/ })).toBeNull();
  });

  it("renders nothing when the feed cannot be read", async () => {
    // A positive control first, so an empty container below means the failure
    // was handled, not that the answer had not arrived yet.
    routeFetch(FEED);
    const good = render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    await screen.findByText("Sharma");
    good.unmount();

    let answered = false;
    authFetchMock.mockImplementation(async () => {
      answered = true;
      return json({ error: "boom" }, 500);
    });
    const { container } = render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    await waitFor(() => expect(answered).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the singular for one household, and can turn the digest back on", async () => {
    routeFetch({
      ...FEED,
      households: 1,
      items: [FEED.items[0]],
      digest: { available: true, enabled: false },
    });
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    expect(await screen.findByText("household changed their RSVP")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: "Email me a daily summary" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    const put = authFetchMock.mock.calls.find(([url]) => String(url).endsWith("/digest"));
    expect(put?.[1]).toMatchObject({ body: JSON.stringify({ enabled: true }) });
  });

  it("offers the digest switch only when the API says this organiser gets one", async () => {
    routeFetch({ ...FEED, digest: { available: false, enabled: true } });
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    await screen.findByText("Sharma");
    expect(screen.queryByRole("checkbox", { name: "Email me a daily summary" })).toBeNull();
  });

  it("saves the switch, and puts it back when the save fails", async () => {
    routeFetch(FEED);
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    const box = await screen.findByRole("checkbox", { name: "Email me a daily summary" });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    const put = authFetchMock.mock.calls.find(([url]) => String(url).endsWith("/digest"));
    expect(put?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ enabled: false }) });

    cleanup();
    routeFetch(FEED, 200, 500);
    render(() => <RsvpChangesCard weddingId="wed_a" onNavigate={() => {}} />);
    const again = await screen.findByRole("checkbox", { name: "Email me a daily summary" });
    fireEvent.click(again);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(again).toBeChecked();
  });
});
