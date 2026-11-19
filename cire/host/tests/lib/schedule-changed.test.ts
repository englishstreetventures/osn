import { describe, expect, it, vi } from "vitest";

import { onScheduleChanged, scheduleChanged } from "../../src/lib/schedule-changed";

/**
 * The dashboard hears each schedule change the tab commits, and stops hearing
 * once it has gone: a dashboard torn down on sign-out or a switch must not
 * keep re-reading the wedding list for a tab that has moved on. That the
 * change re-reads the list is the `cire-event-details` flow's to show.
 */
describe("onScheduleChanged", () => {
  it("tells a listener of each change until it unsubscribes", () => {
    const listener = vi.fn();
    const stop = onScheduleChanged(listener);

    scheduleChanged("wed_a");
    stop();
    scheduleChanged("wed_b");

    expect(listener.mock.calls).toEqual([["wed_a"]]);
  });

  // The import and the revert reload the page, which reads the list afresh.
  it("tells no listener of a change the page is about to reload over", () => {
    const listener = vi.fn();
    const stop = onScheduleChanged(listener);

    scheduleChanged("wed_a", { reloading: true });
    stop();

    expect(listener).not.toHaveBeenCalled();
  });
});
