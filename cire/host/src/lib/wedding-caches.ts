// The lifetime of one wedding's data in the organiser portal's memory.
//
// Every per-wedding store holds rows the organiser loaded for that wedding —
// guest names, vendor emails and phone numbers, budget figures, the gift log.
// They are memory only and last no longer than the tab, but nothing else
// releases them: the maps are keyed by wedding, so wedding A's rows stay
// resident while the organiser works in wedding B. The dashboard opens a
// wedding's caches when it mounts and drops them when it unmounts, so a wedding
// holds data only while it is on screen.
import { dropBudget } from "./budget-store";
import { dropEnquiries } from "./enquiries-store";
import { dropEvents } from "./events-store";
import { dropGuests } from "./guests-store";
import { dropHouseholds } from "./households-store";
import { dropRegistry } from "./registry-store";
import { dropTasks } from "./tasks-store";
import { dropCatalogue } from "./upgrade-store";
import { dropVendors } from "./vendors-store";
import { closeWeddingScope, openWeddingScope } from "./wedding-scope";

/** Let the stores load and write for this wedding again. */
export function openWeddingCaches(weddingId: string): void {
  openWeddingScope(weddingId);
}

/**
 * Release every row held for this wedding and refuse new ones until it is
 * opened again. Closing comes first, so a load that settles while the stores
 * are being emptied cannot refill one already emptied.
 */
export function dropWeddingCaches(weddingId: string): void {
  closeWeddingScope(weddingId);
  dropBudget(weddingId);
  dropEnquiries(weddingId);
  dropEvents(weddingId);
  dropGuests(weddingId);
  dropHouseholds(weddingId);
  dropRegistry(weddingId);
  dropTasks(weddingId);
  dropCatalogue(weddingId);
  dropVendors(weddingId);
}
