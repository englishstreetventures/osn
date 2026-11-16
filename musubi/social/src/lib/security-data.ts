import type { SettingsRead, WriteEnd } from "@osn/auth-ui/settings-read";

import { passkeysClient, recoveryClient, totpClient } from "./authClients";
import { invalidatePages, pageQuery, scopeMark, type PageQuery } from "./page-cache";
import { PAGE_DATA } from "./page-names";

// Settings → Security's reads, on the page cache (`page-cache.ts`), so the
// tab shown again draws its passkeys, its authenticator and its recovery
// count at once and reads them again behind them. Its own module, beside
// `page-data.ts`, so the Security chunk loads only the clients it uses.
//
// None of the three reads takes a step-up token, so nothing here outlives a
// step-up or needs one; every entry goes with the session that read it, as
// every page's does. A write on the tab tells the read how it ended
// (`WriteEnd`), and the tab never shows a row the write may have changed.

/** The account's passkeys. */
export const passkeyList = pageQuery(
  PAGE_DATA.passkeys,
  async () => (await passkeysClient.list()).passkeys,
  (value) => value.length,
);

/** Whether an authenticator app is set up, and its name and times. */
export const authenticatorStatus = pageQuery(
  PAGE_DATA.authenticator,
  () => totpClient.status(),
  () => 1,
);

/** How many recovery codes the account holds and has left: counts, never a code. */
export const recoveryCodesStatus = pageQuery(
  PAGE_DATA.recoveryCodes,
  () => recoveryClient.getRecoveryCodesStatus(),
  () => 1,
);

/** The tab's three reads, by name. */
const SECURITY_PAGES = [PAGE_DATA.passkeys, PAGE_DATA.authenticator, PAGE_DATA.recoveryCodes];

/**
 * `query` as the `@osn/auth-ui` view reads it. Call it in the component that
 * renders the view: the rows are read each time it mounts.
 *
 * A write's end: an exact outcome is written into the rows at once, an
 * unchanged end leaves them, anything else forgets them, so no screen shows a row the write
 * may have changed. Then all three reads are read again — now for those on
 * screen, at their next show for the rest — since a write here runs a step-up
 * first, which moves the "Last used" of the factor it used; a write that ran
 * none (an enrolment's confirm) reads only its own.
 *
 * When the session has changed while the write ran (a profile switch keeps
 * the tab mounted), its outcome is never written: the rows now held were read
 * under the new session, maybe before the write landed, so they are forgotten
 * and read again. Both act only on the current session's own entries.
 */
export function useSettingsRead<T>(query: PageQuery<[], T>): SettingsRead<T> {
  const read = query.use(() => []);
  const landed = () => read.state === "ready" || read.state === "refreshing";
  return {
    value: () => (landed() ? read() : undefined),
    state: () => (landed() ? "ready" : read.state === "errored" ? "errored" : "pending"),
    failure: () => (read.state === "errored" ? { error: read.error } : null),
    settled: () => read.settled(),
    rows: () => read.rows,
    retry: () => void query.refresh(),
    write(options) {
      const mark = scopeMark();
      const steppedUp = options?.steppedUp ?? true;
      let ended = false;
      return (end: WriteEnd<T>) => {
        if (ended) return;
        ended = true;
        if (mark !== scopeMark() || end === "unknown") query.drop();
        else if (typeof end === "object") query.update([], end.outcome, mark);
        // A step-up moved a factor's "Last used", on any of the three.
        if (steppedUp) invalidatePages(...SECURITY_PAGES);
        else query.invalidate();
      };
    },
  };
}
