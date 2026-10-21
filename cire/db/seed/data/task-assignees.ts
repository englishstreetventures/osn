// Who holds which checklist task on the sample wedding. Consumed only by
// cire/db/seed/generate.ts.
//
// Enough for the checklist's holder stack to show each of its states on the
// dev tier: a task two co-hosts share, a task one co-host holds, a done task
// someone held, and a task every seat holds, so the stack has more people than
// it shows faces for. Every other task is held by nobody.
//
// Each row names a task from ./tasks.ts and a seat from ./hosts.ts. Rows are
// written in this order in one second, and a task's holders read back in the
// order they were added, so this order is the order the checklist shows them.

import { hosts } from "./hosts";
import { tasks } from "./tasks";

export type SeedTaskAssignee = {
  readonly taskId: string;
  /** The seat (`wedding_hosts.id`) holding the task. */
  readonly hostId: string;
};

function taskTitled(title: string): string {
  const found = tasks.find((t) => t.title === title);
  if (!found) throw new Error(`No seed task is titled "${title}".`);
  return found.id;
}

const [owner, partner, planner, viewer] = hosts;

export const taskAssignees = [
  { taskId: taskTitled("Book the photographer"), hostId: partner.id },
  { taskId: taskTitled("Send the run sheet to every supplier"), hostId: planner.id },
  { taskId: taskTitled("Send the run sheet to every supplier"), hostId: owner.id },
  { taskId: taskTitled("Send the run sheet to every supplier"), hostId: partner.id },
  { taskId: taskTitled("Send the run sheet to every supplier"), hostId: viewer.id },
  { taskId: taskTitled("Hand the rings to the best man"), hostId: partner.id },
  { taskId: taskTitled("Hand the rings to the best man"), hostId: planner.id },
  { taskId: taskTitled("Pack the emergency kit"), hostId: planner.id },
] as const satisfies readonly SeedTaskAssignee[];
