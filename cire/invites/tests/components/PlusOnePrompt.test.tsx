import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlusOnePrompt } from "../../src/components/PlusOnePrompt";
import type { ClaimResult, FamilyMember, RsvpSummary } from "../../src/components/types";

const API = "https://api.test";

const bo: FamilyMember = {
  guestId: "g-bo",
  firstName: "Bo",
  lastName: "Lee",
  nickname: null,
  eventIds: ["e1", "e2"],
  plusOneAllowed: true,
  plusOneOf: null,
};
const cleo: FamilyMember = {
  guestId: "g-cleo",
  firstName: "Cleo",
  lastName: "Lee",
  nickname: null,
  eventIds: ["e1"],
  plusOneAllowed: false,
  plusOneOf: null,
};
const sam: FamilyMember = {
  guestId: "g-sam",
  firstName: "Sam",
  lastName: "Park",
  nickname: null,
  eventIds: ["e1", "e2"],
  plusOneAllowed: false,
  plusOneOf: "g-bo",
};

const reply = (
  guestId: string,
  eventId: string,
  extra: Partial<RsvpSummary> = {},
): RsvpSummary => ({
  guestId,
  eventId,
  status: "attending",
  dietary: "",
  dietaryPresets: [],
  dietaryConsentCurrent: false,
  ...extra,
});

function household(members: FamilyMember[], rsvps: RsvpSummary[] = []): ClaimResult {
  return { publicId: "LEE-OAK-AB12", familyName: "Lee", members, events: [], rsvps };
}

/** Render the prompt over a live copy of the household, as a page owns it:
 *  `onChange` updates are applied and flow back in. */
function renderPrompt(initial: ClaimResult, closed = false) {
  const [result, setResult] = createSignal(initial);
  const view = render(() => (
    <PlusOnePrompt
      apiUrl={API}
      members={result().members}
      rsvps={result().rsvps}
      closed={closed}
      onChange={(update) => setResult(update(result()))}
    />
  ));
  return { ...view, result };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const savedSam = (extra: Record<string, unknown> = {}) => ({
  plusOne: {
    guestId: "g-sam",
    firstName: "Sam",
    lastName: "Park",
    plusOneOf: "g-bo",
    eventIds: ["e1", "e2"],
  },
  created: true,
  dietaryCleared: false,
  ...extra,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const firstName = () => screen.getByLabelText("First name") as HTMLInputElement;
const lastName = () => screen.getByLabelText("Last name") as HTMLInputElement;

describe("PlusOnePrompt — who is asked", () => {
  it("renders nothing when nobody may bring a guest and none is named", () => {
    const { container } = renderPrompt(household([cleo]));
    expect(container.innerHTML).toBe("");
  });

  it("asks a guest on their own in the second person", () => {
    renderPrompt(household([bo]));
    expect(screen.getByRole("heading", { name: "Bringing a guest" })).toBeTruthy();
    expect(screen.getByText(/You're welcome to bring a guest/)).toBeTruthy();
    // Their own name is not the prompt's label: there is only one of them.
    expect(screen.queryByText("Bo's guest")).toBeNull();
  });

  it("names who may bring a guest in a household, and labels each of their rows", () => {
    renderPrompt(
      household([bo, cleo, { ...cleo, guestId: "g-dot", firstName: "Dot", plusOneAllowed: true }]),
    );
    expect(screen.getByText(/Bo and Dot are each welcome to bring a guest/)).toBeTruthy();
    expect(screen.getByText("Bo's guest")).toBeTruthy();
    expect(screen.getByText("Dot's guest")).toBeTruthy();
    expect(screen.queryByText("Cleo's guest")).toBeNull();
  });

  it("asks for a name the browser will not fill with the guest's own", () => {
    renderPrompt(household([bo]));
    for (const input of [firstName(), lastName()]) {
      expect(input.getAttribute("autocomplete")).toBe("off");
      expect(input.maxLength).toBe(100);
    }
  });

  /**
   * The person named never sees the invite, so the household is the only way
   * the privacy notice reaches them (GDPR Art. 14).
   */
  it("asks the household to share the privacy notice with their guest", () => {
    renderPrompt(household([bo]));
    const link = screen.getByRole("link", { name: "privacy notice" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/privacy");
    expect(link.closest("p")?.textContent).toMatch(/won't see this invitation/);
  });
});

describe("PlusOnePrompt — naming a guest", () => {
  it("names them, places them on the page and moves focus to their controls", async () => {
    fetchMock.mockResolvedValue(json(200, savedSam()));
    const { result } = renderPrompt(household([bo, cleo]));

    fireEvent.input(firstName(), { target: { value: "  Sam " } });
    fireEvent.input(lastName(), { target: { value: "Park" } });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));

    await waitFor(() => expect(screen.getByText("Sam Park")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API}/api/plus-one/g-bo`);
    expect(init).toMatchObject({ method: "PUT", credentials: "include" });
    expect(JSON.parse(init.body)).toEqual({ firstName: "Sam", lastName: "Park" });
    expect(result().members.map((m) => m.guestId)).toEqual(["g-bo", "g-sam", "g-cleo"]);
    expect(document.activeElement?.textContent).toBe("Change name");
  });

  it("sends nothing without a first name", async () => {
    renderPrompt(household([bo]));
    fireEvent.input(lastName(), { target: { value: "Park" } });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/first name/));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when another device had already named someone", async () => {
    fetchMock.mockResolvedValue(
      json(
        200,
        savedSam({
          created: false,
          plusOne: { ...savedSam().plusOne, firstName: "Alex", lastName: "" },
        }),
      ),
    );
    renderPrompt(household([bo]));
    fireEvent.input(firstName(), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    await waitFor(() => expect(screen.getByText(/already added/)).toBeTruthy());
    expect(screen.getByText("Alex")).toBeTruthy();
  });

  it("explains a refusal and keeps what was typed", async () => {
    fetchMock.mockResolvedValue(json(409, { error: "guest_capacity" }));
    renderPrompt(household([bo]));
    fireEvent.input(firstName(), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/guest list is full/),
    );
    expect(firstName().value).toBe("Sam");
  });

  it("asks for a reload when a saved guest comes back in a shape it cannot place", async () => {
    fetchMock.mockResolvedValue(json(200, { plusOne: null, created: true }));
    const { result } = renderPrompt(household([bo]));
    fireEvent.input(firstName(), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/reload the page/));
    expect(result().members.map((m) => m.guestId)).toEqual(["g-bo"]);
  });

  it("explains a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    renderPrompt(household([bo]));
    fireEvent.input(firstName(), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not connect/));
  });
});

describe("PlusOnePrompt — a named guest", () => {
  it("shows them with their controls, and says while they still need an answer", () => {
    renderPrompt(household([bo, sam], [reply("g-sam", "e1")]));
    expect(screen.getByText("Sam Park")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByText(/Answer for Sam under Respond/)).toBeTruthy();
    expect(screen.queryByLabelText("First name")).toBeNull();
  });

  it("stops reminding once every event has an answer for them", () => {
    renderPrompt(household([bo, sam], [reply("g-sam", "e1"), reply("g-sam", "e2")]));
    expect(screen.queryByText(/Answer for Sam under Respond/)).toBeNull();
  });

  it("renames them in place", async () => {
    fetchMock.mockResolvedValue(
      json(
        200,
        savedSam({ created: false, plusOne: { ...savedSam().plusOne, firstName: "Samuel" } }),
      ),
    );
    const { result } = renderPrompt(household([bo, sam]));

    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    expect(document.activeElement).toBe(firstName());
    expect(firstName().value).toBe("Sam");
    expect(lastName().value).toBe("Park");
    fireEvent.input(firstName(), { target: { value: "Samuel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(screen.getByText("Samuel Park")).toBeTruthy());
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "PUT" });
    expect(result().members.map((m) => m.firstName)).toEqual(["Bo", "Samuel"]);
    expect(document.activeElement?.textContent).toBe("Change name");
  });

  it("warns that a new name clears their dietary answers, and says when it did", async () => {
    fetchMock.mockResolvedValue(
      json(
        200,
        savedSam({
          created: false,
          dietaryCleared: true,
          plusOne: { ...savedSam().plusOne, firstName: "Alex", lastName: "" },
        }),
      ),
    );
    const { result } = renderPrompt(
      household(
        [bo, sam],
        [reply("g-sam", "e1", { dietaryPresets: ["nuts"], dietaryConsentCurrent: true })],
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    expect(screen.getByText(/clears the dietary requirements you gave for Sam/)).toBeTruthy();
    fireEvent.input(firstName(), { target: { value: "Alex" } });
    fireEvent.input(lastName(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(screen.getByText(/were cleared/)).toBeTruthy());
    expect(result().rsvps[0]).toMatchObject({ dietaryPresets: [], dietaryConsentCurrent: false });
  });

  it("leaves the name alone when the change is cancelled", () => {
    renderPrompt(household([bo, sam]));
    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    fireEvent.input(firstName(), { target: { value: "Zed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Sam Park")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Change name");
  });

  it("asks before removing them, and keeps them on Keep", () => {
    renderPrompt(household([bo, sam]));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/Remove Sam Park\?/)).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Keep");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByText("Sam Park")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Remove");
  });

  it("removes them, with their replies, and offers the form again", async () => {
    fetchMock.mockResolvedValue(json(200, { removed: true }));
    const { result } = renderPrompt(household([bo, sam], [reply("g-sam", "e1")]));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));

    await waitFor(() => expect(screen.getByLabelText("First name")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API}/api/plus-one/g-bo`);
    expect(init).toMatchObject({ method: "DELETE", credentials: "include" });
    expect(result().members.map((m) => m.guestId)).toEqual(["g-bo"]);
    expect(result().rsvps).toEqual([]);
    expect(document.activeElement).toBe(firstName());
  });

  it("keeps the guest, and says why, when the removal is refused", async () => {
    fetchMock.mockResolvedValue(json(403, { error: "rsvp_closed" }));
    const { result } = renderPrompt(household([bo, sam], [reply("g-sam", "e1")]));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/RSVPs have closed/));
    expect(result().members.map((m) => m.guestId)).toEqual(["g-bo", "g-sam"]);
    expect(result().rsvps).toHaveLength(1);
  });

  it("offers removal but not a rename once the member may no longer bring a guest", () => {
    renderPrompt(household([{ ...bo, plusOneAllowed: false }, sam]));
    expect(screen.getByText("Sam Park")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change name" })).toBeNull();
  });
});

describe("PlusOnePrompt — after the RSVP deadline", () => {
  it("shows a named guest without controls", () => {
    const { container } = renderPrompt(household([bo, sam]), true);
    expect(within(container).getByText("Sam Park")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("First name")).toBeNull();
    expect(screen.queryByText(/Answer for Sam/)).toBeNull();
  });

  it("offers nothing when no guest was named in time", () => {
    const { container } = renderPrompt(household([bo]), true);
    expect(container.innerHTML).toBe("");
  });
});
