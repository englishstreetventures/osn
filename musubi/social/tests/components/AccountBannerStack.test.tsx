// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * One banner at a time, and security events win.
 *
 * An unacknowledged security event describes something that already happened
 * to the account and costs a step-up ceremony to clear, so it stays on screen
 * until the user deals with it; a recovery-code offer is housekeeping. The two
 * coexisting is ordinary rather than rare — most of the event kinds the server
 * records sit happily on an account that has never generated a code — so the
 * suppression here is what stops a user in that state carrying two banners on
 * every page.
 *
 * Both banners are stubbed. What is under test is which of them renders.
 */

const captured = vi.hoisted(() => ({
  report: undefined as ((count: number) => void) | undefined,
  eventsToken: undefined as string | undefined,
  promptToken: undefined as string | undefined,
}));

vi.mock("../../src/components/SecurityEventsBannerMount", () => ({
  default: (props: { accessToken: string; onVisibleCountChange?: (count: number) => void }) => {
    captured.report = props.onVisibleCountChange;
    captured.eventsToken = props.accessToken;
    return <div data-testid="events" />;
  },
}));
vi.mock("../../src/components/RecoveryCodesPrompt", () => ({
  RecoveryCodesPrompt: (props: { accessToken: string }) => {
    captured.promptToken = props.accessToken;
    return <div data-testid="prompt" />;
  },
}));

import AccountBannerStack from "../../src/components/AccountBannerStack";

afterEach(() => {
  cleanup();
  captured.report = undefined;
  captured.eventsToken = undefined;
  captured.promptToken = undefined;
});

describe("<AccountBannerStack />", () => {
  it("withholds the prompt until the event count settles", () => {
    render(() => <AccountBannerStack accessToken="tkn" />);

    // Nothing has reported yet. Rendering the prompt now would flash it in and
    // then pull it when an event lands.
    expect(screen.getByTestId("events")).toBeTruthy();
    expect(screen.queryByTestId("prompt")).toBeNull();
  });

  it("shows the prompt once the events banner settles with nothing", () => {
    render(() => <AccountBannerStack accessToken="tkn" />);
    captured.report?.(0);
    expect(screen.getByTestId("prompt")).toBeTruthy();
  });

  it("suppresses the prompt while a security event is unacknowledged", () => {
    render(() => <AccountBannerStack accessToken="tkn" />);
    captured.report?.(2);
    expect(screen.getByTestId("events")).toBeTruthy();
    expect(screen.queryByTestId("prompt")).toBeNull();
  });

  it("shows the prompt after the events are acknowledged", () => {
    render(() => <AccountBannerStack accessToken="tkn" />);
    captured.report?.(2);
    captured.report?.(0);
    expect(screen.getByTestId("prompt")).toBeTruthy();
  });

  it("takes up no vertical space while neither banner has anything to say", () => {
    const { container } = render(() => <AccountBannerStack accessToken="tkn" />);
    captured.report?.(0);

    // The container carries horizontal padding only; the banner that renders
    // brings its own vertical space. Otherwise every route in the app gains a
    // gap for banners that are not there, which is the common case.
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toMatch(/(^|\s)(py|pt|pb)-/);
    const eventsSlot = screen.getByTestId("events").parentElement as HTMLElement;
    expect(eventsSlot.className).not.toMatch(/(^|\s)pt-/);
  });

  it("gives the events banner its spacing only when it is showing", () => {
    render(() => <AccountBannerStack accessToken="tkn" />);
    captured.report?.(1);
    const eventsSlot = screen.getByTestId("events").parentElement as HTMLElement;
    expect(eventsSlot.className).toMatch(/(^|\s)pt-6(\s|$)/);
  });

  it("hands both banners the signed-in access token", () => {
    render(() => <AccountBannerStack accessToken="tkn" />);
    captured.report?.(0);
    expect(captured.eventsToken).toBe("tkn");
    expect(captured.promptToken).toBe("tkn");
  });
});
