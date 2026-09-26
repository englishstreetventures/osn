// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invite builder's FAQ editor: every change is an immediate API call, the
 * list lives with the builder (so this test holds it in a signal and feeds each
 * reported list back), moves are saved together, and Enter in the question
 * saves the entry rather than the invite form around it.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../../test-support/mocks");
  return toastMock();
});

vi.mock("../../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../../test-support/mocks");
  return organiserApiMock();
});

import FaqEditor, { ORDER_SAVE_DELAY_MS } from "../../../src/components/invite/FaqEditor";
import { FAQ_CAPS, type FaqEntry } from "../../../src/components/invite/model";
import {
  authFetchMock,
  redirectSpy,
  resetOrganiserMocks,
  toastSuccess,
} from "../../test-support/mocks";

const BASE = "https://api.test/api/organiser/weddings/wed_1/invite/faqs";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PARKING: FaqEntry = { id: "faq_a", question: "Is there parking?", answer: "Yes." };
const CHILDREN: FaqEntry = { id: "faq_b", question: "Are children invited?", answer: "Ceremony." };
const TIMING: FaqEntry = { id: "faq_c", question: "When should we arrive?", answer: "At three." };

/** The lists the editor reported, and the pending flags, in order. */
let reported: FaqEntry[][] = [];
let pending: boolean[] = [];

function renderEditor(initial: FaqEntry[] | undefined) {
  reported = [];
  pending = [];
  const [entries, setEntries] = createSignal(initial);
  const submit = vi.fn((e: Event) => e.preventDefault());
  const view = render(() => (
    // The builder is one form whose submit saves the invite; the editor sits
    // inside it.
    <form onSubmit={submit}>
      <FaqEditor
        weddingId="wed_1"
        entries={entries()}
        onEntriesChange={(next) => {
          reported.push(next);
          setEntries(next);
        }}
        onPendingChange={(p) => pending.push(p)}
      />
    </form>
  ));
  return { ...view, submit, entries };
}

/** Question texts, in the order the list shows them. */
const shownOrder = () =>
  [...document.querySelectorAll("[data-faq-entry]")].map(
    (li) => li.querySelector("p")?.textContent ?? "",
  );

const calls = (method: string, url: string) =>
  authFetchMock.mock.calls.filter(
    (c) => String(c[0]) === url && (c[1]?.method ?? "GET") === method,
  );

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

// happy-dom ships no window.confirm; deleting asks, and says yes unless a test
// says otherwise.
const confirmSpy = vi.fn();

beforeEach(() => {
  confirmSpy.mockReset().mockReturnValue(true);
  vi.stubGlobal("confirm", confirmSpy);
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FaqEditor", () => {
  it("says the FAQ is not available yet when the API sent no entries", () => {
    renderEditor(undefined);
    expect(screen.getByText(/Questions can't be edited yet/)).toBeInTheDocument();
    expect(screen.queryByText("Add a question")).not.toBeInTheDocument();
  });

  it("lists the entries in order with a count", () => {
    renderEditor([PARKING, CHILDREN]);
    expect(shownOrder()).toEqual(["Is there parking?", "Are children invited?"]);
    expect(screen.getByText(`2 of ${FAQ_CAPS.maxEntries} questions`)).toBeInTheDocument();
    expect(screen.getByText("Applies immediately")).toBeInTheDocument();
  });

  it("renders organiser text as text, never as markup", () => {
    renderEditor([{ id: "faq_x", question: "<img src=x onerror=alert(1)>", answer: "<b>hi</b>" }]);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("[data-faq-entry] img")).toBeNull();
    expect(document.querySelector("[data-faq-entry] b")).toBeNull();
  });

  it("adds an entry at the end with one POST", async () => {
    authFetchMock.mockResolvedValueOnce(json({ faq: TIMING }));
    renderEditor([PARKING]);

    fireEvent.click(screen.getByText("Add a question"));
    const add = screen.getByText("Add question") as HTMLButtonElement;
    // Both fields are needed, and whitespace is not text.
    expect(add.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Question"), { target: { value: "When?" } });
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "   " } });
    expect(add.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "At three." } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);

    await waitFor(() => expect(reported.at(-1)).toEqual([PARKING, TIMING]));
    const [post] = calls("POST", BASE);
    expect(bodyOf(post!)).toEqual({ question: "When?", answer: "At three." });
    expect(toastSuccess).toHaveBeenCalledWith("Question added");
    // The form closes once saved.
    expect(screen.queryByLabelText("Question")).not.toBeInTheDocument();
  });

  it("saves the entry on Enter in the question, not the invite form around it", async () => {
    authFetchMock.mockResolvedValueOnce(json({ faq: TIMING }));
    const { submit } = renderEditor([]);

    fireEvent.click(screen.getByText("Add a question"));
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "At three." } });
    const questionInput = screen.getByLabelText("Question");
    fireEvent.input(questionInput, { target: { value: "When?" } });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    questionInput.dispatchEvent(enter);

    // Cancelling the keydown is what stops the browser's implicit submission of
    // the builder's form.
    expect(enter.defaultPrevented).toBe(true);
    await waitFor(() => expect(calls("POST", BASE)).toHaveLength(1));
    expect(submit).not.toHaveBeenCalled();
  });

  it("leaves Enter in the answer alone, for a new line", () => {
    renderEditor([]);
    fireEvent.click(screen.getByText("Add a question"));
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    screen.getByLabelText("Answer").dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("names the cap when the API refuses an entry past it", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "faq_limit_reached" }, 409));
    renderEditor([PARKING]);
    fireEvent.click(screen.getByText("Add a question"));
    fireEvent.input(screen.getByLabelText("Question"), { target: { value: "One more?" } });
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "No." } });
    fireEvent.click(screen.getByText("Add question"));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain(`${FAQ_CAPS.maxEntries} questions`);
    // Nothing reported, and the typing is kept for another try.
    expect(reported).toEqual([]);
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("One more?");
  });

  it("offers no Add at the cap, and says why", () => {
    const full = Array.from({ length: FAQ_CAPS.maxEntries }, (_, i) => ({
      id: `faq_${i}`,
      question: `Question ${i}?`,
      answer: "Yes.",
    }));
    renderEditor(full);
    expect(screen.queryByText("Add a question")).not.toBeInTheDocument();
    expect(screen.getByText(/That's the most an invite can hold/)).toBeInTheDocument();
  });

  it("edits an entry in place with one PUT", async () => {
    const edited = { ...CHILDREN, answer: "To the ceremony, yes." };
    authFetchMock.mockResolvedValueOnce(json({ faq: edited }));
    renderEditor([PARKING, CHILDREN]);

    fireEvent.click(screen.getByRole("button", { name: "Edit “Are children invited?”" }));
    const answer = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    expect(answer.value).toBe("Ceremony.");
    fireEvent.input(answer, { target: { value: "To the ceremony, yes." } });
    fireEvent.click(screen.getByText("Save question"));

    await waitFor(() => expect(reported.at(-1)).toEqual([PARKING, edited]));
    const [put] = calls("PUT", `${BASE}/faq_b`);
    expect(bodyOf(put!)).toEqual({
      question: "Are children invited?",
      answer: "To the ceremony, yes.",
    });
  });

  it("deletes an entry after asking, and not without", async () => {
    authFetchMock.mockResolvedValueOnce(json({ ok: true }));
    renderEditor([PARKING, CHILDREN]);

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete “Is there parking?”" }));
    expect(authFetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete “Is there parking?”" }));
    await waitFor(() => expect(reported.at(-1)).toEqual([CHILDREN]));
    expect(calls("DELETE", `${BASE}/faq_a`)).toHaveLength(1);
  });

  it("sends a signed-out organiser to sign in", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "unauthorised" }, 401));
    renderEditor([PARKING]);
    fireEvent.click(screen.getByRole("button", { name: "Delete “Is there parking?”" }));
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("says a question no longer exists when the API cannot find it", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "faq_not_found" }, 404));
    renderEditor([PARKING]);
    fireEvent.click(screen.getByRole("button", { name: "Edit “Is there parking?”" }));
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "No." } });
    fireEvent.click(screen.getByText("Save question"));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("no longer exists");
    expect(reported).toEqual([]);
  });

  it("keeps a question the API refused to delete", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "Internal error" }, 500));
    renderEditor([PARKING]);
    fireEvent.click(screen.getByRole("button", { name: "Delete “Is there parking?”" }));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("Couldn't delete that question.");
    expect(reported).toEqual([]);
    expect(shownOrder()).toEqual(["Is there parking?"]);
  });

  it("says so when a save cannot reach the API, and keeps the typing", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderEditor([]);
    fireEvent.click(screen.getByText("Add a question"));
    fireEvent.input(screen.getByLabelText("Question"), { target: { value: "Parking?" } });
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "Yes." } });
    fireEvent.click(screen.getByText("Add question"));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("Couldn't save that question.");
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Parking?");
  });

  it("sends an organiser whose session expired mid-save to sign in", async () => {
    authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError"));
    renderEditor([]);
    fireEvent.click(screen.getByText("Add a question"));
    fireEvent.input(screen.getByLabelText("Question"), { target: { value: "Parking?" } });
    fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "Yes." } });
    fireEvent.click(screen.getByText("Add question"));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("focus", () => {
    it("moves to the question when a form opens, and back to Add on cancel", () => {
      renderEditor([PARKING]);
      fireEvent.click(screen.getByText("Add a question"));
      expect(document.activeElement).toBe(screen.getByLabelText("Question"));
      fireEvent.click(screen.getByText("Cancel"));
      expect(document.activeElement).toBe(screen.getByText("Add a question"));
    });

    it("returns to the row's Edit after an edit is cancelled or saved", async () => {
      authFetchMock.mockResolvedValueOnce(json({ faq: { ...PARKING, answer: "No." } }));
      renderEditor([PARKING, CHILDREN]);
      const edit = () => screen.getByRole("button", { name: "Edit “Is there parking?”" });

      fireEvent.click(edit());
      expect(document.activeElement).toBe(screen.getByLabelText("Question"));
      fireEvent.click(screen.getByText("Cancel"));
      expect(document.activeElement).toBe(edit());

      fireEvent.click(edit());
      fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "No." } });
      fireEvent.click(screen.getByText("Save question"));
      await waitFor(() => expect(document.activeElement).toBe(edit()));
    });

    it("stays on Add after adding, ready for the next question", async () => {
      authFetchMock.mockResolvedValueOnce(json({ faq: TIMING }));
      renderEditor([]);
      fireEvent.click(screen.getByText("Add a question"));
      fireEvent.input(screen.getByLabelText("Question"), { target: { value: "When?" } });
      fireEvent.input(screen.getByLabelText("Answer"), { target: { value: "At three." } });
      fireEvent.click(screen.getByText("Add question"));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Add a question")));
    });

    it("moves to the next row's Edit after a delete, or Add when none is left", async () => {
      authFetchMock.mockResolvedValue(json({ ok: true }));
      renderEditor([PARKING, CHILDREN]);

      fireEvent.click(screen.getByRole("button", { name: "Delete “Is there parking?”" }));
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Edit “Are children invited?”" }),
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "Delete “Are children invited?”" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Add a question")));
    });
  });

  it("reports pending while the form has typing in it", () => {
    renderEditor([PARKING]);
    fireEvent.click(screen.getByText("Add a question"));
    expect(pending.at(-1)).toBe(false);
    fireEvent.input(screen.getByLabelText("Question"), { target: { value: "W" } });
    expect(pending.at(-1)).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    expect(pending.at(-1)).toBe(false);
  });

  describe("reordering", () => {
    const grip = (question: string) =>
      screen.getByRole("button", { name: new RegExp(`^Reorder ${question}`) });

    it("moves at once and saves the final order in ONE PUT", async () => {
      authFetchMock.mockResolvedValue(json({ ok: true }));
      renderEditor([PARKING, CHILDREN, TIMING]);

      // Two presses, one after the other — a keyboard walk.
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      expect(shownOrder()).toEqual([
        "Are children invited?",
        "Is there parking?",
        "When should we arrive?",
      ]);
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      expect(shownOrder()[2]).toBe("Is there parking?");
      expect(pending.at(-1)).toBe(true);
      expect(calls("PUT", `${BASE}/order`)).toHaveLength(0);

      await waitFor(() => expect(calls("PUT", `${BASE}/order`)).toHaveLength(1), {
        timeout: ORDER_SAVE_DELAY_MS + 1000,
      });
      expect(bodyOf(calls("PUT", `${BASE}/order`)[0]!)).toEqual({
        orderedIds: ["faq_b", "faq_c", "faq_a"],
      });
      await waitFor(() => expect(pending.at(-1)).toBe(false));
    });

    it("sends nothing when a row is moved and moved back inside the pause", async () => {
      authFetchMock.mockResolvedValue(json({ ok: true }));
      renderEditor([PARKING, CHILDREN]);
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowUp" });
      expect(pending.at(-1)).toBe(true);
      await waitFor(() => expect(pending.at(-1)).toBe(false), {
        timeout: ORDER_SAVE_DELAY_MS + 1000,
      });
      expect(calls("PUT", `${BASE}/order`)).toHaveLength(0);
    });

    it("keeps focus on the moved grip and announces the move", () => {
      authFetchMock.mockResolvedValue(json({ ok: true }));
      renderEditor([PARKING, CHILDREN]);
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(grip("Is there parking\\?"));
      expect(screen.getByRole("status").textContent).toBe(
        "Is there parking? moved to position 2 of 2.",
      );
    });

    it("puts the old order back and says so when the save fails", async () => {
      authFetchMock.mockResolvedValue(json({ error: "Internal error" }, 500));
      renderEditor([PARKING, CHILDREN]);
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      expect(shownOrder()[0]).toBe("Are children invited?");

      const alert = await waitFor(() => screen.getByRole("alert"), {
        timeout: ORDER_SAVE_DELAY_MS + 1000,
      });
      expect(alert.textContent).toContain("Couldn't save the new order");
      expect(shownOrder()).toEqual(["Is there parking?", "Are children invited?"]);
      // The live region no longer asserts a move that was undone.
      expect(screen.getByRole("status").textContent).toBe("");
      await waitFor(() => expect(pending.at(-1)).toBe(false));
    });

    it("sends a signed-out organiser to sign in when the order save is refused", async () => {
      authFetchMock.mockResolvedValue(json({ error: "unauthorised" }, 401));
      renderEditor([PARKING, CHILDREN]);
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      await waitFor(() => expect(redirectSpy).toHaveBeenCalled(), {
        timeout: ORDER_SAVE_DELAY_MS + 1000,
      });
    });

    it("holds a move made while a save is in flight, then sends the final order", async () => {
      let release!: (res: Response) => void;
      authFetchMock.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (release = resolve)),
      );
      authFetchMock.mockResolvedValue(json({ ok: true }));
      renderEditor([PARKING, CHILDREN, TIMING]);

      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      await waitFor(() => expect(calls("PUT", `${BASE}/order`)).toHaveLength(1), {
        timeout: ORDER_SAVE_DELAY_MS + 1000,
      });

      // A second move while the first save is still out: still one request.
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      await new Promise((r) => setTimeout(r, ORDER_SAVE_DELAY_MS + 100));
      expect(calls("PUT", `${BASE}/order`)).toHaveLength(1);

      // The first returns; the held move goes out with the order as it now stands.
      release(json({ ok: true }));
      await waitFor(() => expect(calls("PUT", `${BASE}/order`)).toHaveLength(2));
      expect(bodyOf(calls("PUT", `${BASE}/order`)[1]!)).toEqual({
        orderedIds: ["faq_b", "faq_c", "faq_a"],
      });
      await waitFor(() => expect(pending.at(-1)).toBe(false));
    });

    it("rolls back to the last order the server accepted, not the first", async () => {
      authFetchMock.mockResolvedValueOnce(json({ ok: true }));
      authFetchMock.mockResolvedValueOnce(json({ error: "Internal error" }, 500));
      renderEditor([PARKING, CHILDREN, TIMING]);

      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      await waitFor(() => expect(calls("PUT", `${BASE}/order`)).toHaveLength(1), {
        timeout: ORDER_SAVE_DELAY_MS + 1000,
      });
      await waitFor(() => expect(pending.at(-1)).toBe(false));
      const accepted = shownOrder();

      fireEvent.keyDown(grip("When should we arrive\\?"), { key: "ArrowUp" });
      await waitFor(() => screen.getByRole("alert"), { timeout: ORDER_SAVE_DELAY_MS + 1000 });
      expect(shownOrder()).toEqual(accepted);
      expect(accepted).toEqual([
        "Are children invited?",
        "Is there parking?",
        "When should we arrive?",
      ]);
    });

    it("saves a pending order when the editor goes away inside the pause", () => {
      authFetchMock.mockResolvedValue(json({ ok: true }));
      const { unmount } = renderEditor([PARKING, CHILDREN]);
      fireEvent.keyDown(grip("Is there parking\\?"), { key: "ArrowDown" });
      unmount();
      const [put] = calls("PUT", `${BASE}/order`);
      expect(bodyOf(put!)).toEqual({ orderedIds: ["faq_b", "faq_a"] });
    });
  });
});
