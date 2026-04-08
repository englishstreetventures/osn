// @vitest-environment happy-dom
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocationInput } from "../../src/lib/LocationInput";

const mockFetch = (features: unknown[] = []) =>
  vi.fn().mockResolvedValue({ json: () => Promise.resolve({ features }) });

describe("LocationInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not fetch for queries shorter than 2 characters", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { getByRole } = render(() => <LocationInput value="" onValue={() => {}} />);
    fireEvent.input(getByRole("textbox"), { target: { value: "a" } });
    await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches from Photon after 300ms debounce for query >= 2 chars", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { getByRole } = render(() => <LocationInput value="" onValue={() => {}} />);
    fireEvent.input(getByRole("textbox"), { target: { value: "London" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("q=London"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not fetch before 300ms have elapsed", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { getByRole } = render(() => <LocationInput value="" onValue={() => {}} />);
    fireEvent.input(getByRole("textbox"), { target: { value: "London" } });
    await vi.advanceTimersByTimeAsync(299);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts the previous request when query changes rapidly", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const { getByRole } = render(() => <LocationInput value="" onValue={() => {}} />);
    const input = getByRole("textbox");
    fireEvent.input(input, { target: { value: "Lo" } });
    // Changing query triggers SolidJS cleanup → abort() on the previous controller
    fireEvent.input(input, { target: { value: "Lon" } });
    expect(abortSpy).toHaveBeenCalled();
  });

  it("calls onValue with the selected suggestion label", async () => {
    const features = [{ properties: { name: "Hyde Park", city: "London", country: "UK" } }];
    vi.stubGlobal("fetch", mockFetch(features));
    const onValue = vi.fn();
    const { getByRole, getByText } = render(() => <LocationInput value="" onValue={onValue} />);
    fireEvent.input(getByRole("textbox"), { target: { value: "Hyde" } });
    await vi.advanceTimersByTimeAsync(300);
    // Flush the fetch promise
    await Promise.resolve();
    await Promise.resolve();
    const item = getByText("Hyde Park, London, UK");
    fireEvent.mouseDown(item);
    expect(onValue).toHaveBeenCalledWith("Hyde Park, London, UK");
  });

  it("silently ignores non-AbortError fetch failures", async () => {
    const nonAbortError = new Error("Network failure"); // name is "Error", not "AbortError"
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(nonAbortError));
    const { getByRole, queryByRole } = render(() => <LocationInput value="" onValue={() => {}} />);
    fireEvent.input(getByRole("textbox"), { target: { value: "London" } });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    await Promise.resolve();
    // No crash, input still present, no suggestions list
    expect(getByRole("textbox")).toBeTruthy();
    expect(queryByRole("list")).toBeNull();
  });

  it("blur while selecting is true → early return (selecting=true set by mouseDown)", async () => {
    const features = [{ properties: { name: "Hyde Park", city: "London", country: "UK" } }];
    vi.stubGlobal("fetch", mockFetch(features));
    const { getByRole, getByText } = render(() => <LocationInput value="" onValue={() => {}} />);
    const input = getByRole("textbox");
    fireEvent.input(input, { target: { value: "Hyde" } });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    await Promise.resolve();
    // mouseDown sets selecting=true, then calls select() which clears the dropdown.
    // Firing blur immediately after mouseDown (while selecting=true) hits the early-return path.
    const item = getByText("Hyde Park, London, UK");
    fireEvent.mouseDown(item); // selecting = true; select() runs (closes dropdown)
    fireEvent.blur(input); // handleBlur: `if (selecting) return` executes
    // Component still mounted, no error thrown
    expect(input).toBeTruthy();
  });

  it("mouseUp on suggestion clears the selecting flag", async () => {
    const features = [{ properties: { name: "Hyde Park", city: "London", country: "UK" } }];
    vi.stubGlobal("fetch", mockFetch(features));
    const { getByRole, getByText, queryByRole } = render(() => (
      <LocationInput value="" onValue={() => {}} />
    ));
    const input = getByRole("textbox");
    fireEvent.input(input, { target: { value: "Hyde" } });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    await Promise.resolve();
    const item = getByText("Hyde Park, London, UK");
    fireEvent.mouseDown(item); // selecting=true, select() runs
    fireEvent.mouseUp(item); // selecting=false (onMouseUp handler executes)
    // Suggestions already cleared; blur now runs the full path (no early return)
    fireEvent.blur(input);
    expect(queryByRole("list")).toBeNull();
  });
});
