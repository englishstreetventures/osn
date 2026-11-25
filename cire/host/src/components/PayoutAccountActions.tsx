import Button from "@cire/ui/button";
import Loading from "@cire/ui/loading";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { heldWhileClosing, Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { batch, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import {
  ensureHostsLoaded,
  hostsAccessor,
  type HostSeat,
  invalidateHosts,
  seatName,
} from "../lib/hosts-store";
import type { RegistrySettings } from "../lib/registry-store";
import { haptic } from "../lib/touch-feedback";
import { normaliseWeddingRole } from "../lib/wedding-roles";

/**
 * Which way an owner may stop the wedding using its Stripe account
 * (`…/registry/stripe/retire`, design note `2026-11-17-cire-gift-payout-design.md`):
 *
 * - `holder`: the owner who connected it, an owner here, hands money gifts to
 *   another owner or disconnects it;
 * - `other`: any other owner replaces it with their own while its holder is
 *   still an owner (the holder is emailed);
 * - `absent`: no current owner holds it, so money gifts are closed, and any
 *   owner uses their own account instead.
 */
export type PayoutAccountMode = "holder" | "other" | "absent";

/** Which dialog is open. */
type Asking = "handover" | "disconnect" | "replace";

/** What the panel does once the account is retired and any dialog has closed. */
export type AfterRetire = "focus" | "connect";

interface PayoutAccountActionsProps {
  weddingId: string;
  /** `null` draws no button: no account, or the reader is not an owner. */
  mode: PayoutAccountMode | null;
  /** The account's holder, by profile id, to name them in the replace dialog. */
  holderId: string | null;
  /** A Stripe read or a connect is out: no retire starts meanwhile. */
  busy: boolean;
  /** Put settings the API answered with into the panel's snapshot. */
  onSettings: (next: RegistrySettings) => void;
  /** A retire has committed: the panel drops any Stripe read already out. */
  onRetired: () => void;
  /** Run once the account is retired and its dialog has closed. */
  onNext: (next: AfterRetire) => void;
  /** Read the settings again, or `null` when the read failed. */
  readSettings: () => Promise<RegistrySettings | null>;
}

/** Each dialog's question, its words, and its commit, idle and pressed. */
const DIALOG = {
  handover: {
    title: "Hand money gifts to another owner?",
    body: "Guests can’t give money until they connect an account and Stripe can take payments for it. Gifts already given, and any refund or dispute on them, stay with your Stripe account.",
    commit: "Hand over",
    pressed: "Handing over…",
  },
  disconnect: {
    title: "Disconnect your Stripe account?",
    body: "Guests can’t give money until an owner connects an account and Stripe can take payments for it. Gifts already given, and any refund or dispute on them, stay with your Stripe account. Every owner gets an email.",
    commit: "Disconnect",
    pressed: "Disconnecting…",
  },
  replace: {
    title: "Replace the Stripe account with your own?",
    body: "gets an email saying so, as does every owner. Guests can’t give money until your account can take payments. Gifts already given, and any refund or dispute on them, stay with the account they were paid into.",
    commit: "Replace it",
    pressed: "Replacing…",
  },
} as const satisfies Record<
  Asking,
  { title: string; body: string; commit: string; pressed: string }
>;

/**
 * The Money gifts panel's controls for changing whose Stripe account takes the
 * wedding's gifts, and the dialogs behind them. The panel draws its account
 * status; this draws the buttons in the panel's row of actions and asks first
 * where the note asks (hand over, disconnect, replace).
 *
 * KEPT MOUNTED ACROSS THE RETIRE. The panel keeps this mounted for an owner
 * whatever the account, so a dialog whose retire has just cleared the account
 * still plays its exit, and its `onClose` still runs. What follows the retire
 * — focus on the Connect button, or the Connect choice — waits for that
 * close: until the native dialog has closed, the page behind it is inert, and
 * its close hands focus back to the button that opened it, which has gone.
 *
 * NAMES COME FROM THE SEATS. The settings carry profile ids only, so the
 * hand-over and replace dialogs read `GET …/hosts` when they open (the shared
 * seat cache, which the checklist reads too).
 */
export default function PayoutAccountActions(props: PayoutAccountActionsProps) {
  const { authFetch, activeProfileId } = useAuth();
  const ids = { title: createUniqueId(), choose: createUniqueId() };

  const [asking, setAsking] = createSignal<Asking | null>(null);
  /** What the dialog draws: `Modal` unmounts its body only once its exit has played. */
  const shown = heldWhileClosing(asking);
  const [working, setWorking] = createSignal(false);
  /** The owner a hand-over names, by profile id; `""` while none is chosen. */
  const [chosen, setChosen] = createSignal("");
  const [seatsFailed, setSeatsFailed] = createSignal(false);
  const seats = hostsAccessor(props.weddingId);

  /** What runs once the open dialog has closed. `onClose` takes it and clears it. */
  let afterClose: (() => void) | null = null;

  /** Every other owner, the ones money gifts can be handed to. */
  const otherOwners = (): HostSeat[] => {
    const me = activeProfileId();
    return (seats() ?? []).filter(
      (seat) => normaliseWeddingRole(seat.role) === "owner" && seat.osnProfileId !== me,
    );
  };
  /** The owner a hand-over names: the one other owner, or the one chosen. */
  const handTo = (): string => {
    const owners = otherOwners();
    return owners.length === 1 ? (owners[0]?.osnProfileId ?? "") : chosen();
  };
  const nameOf = (profileId: string): string => {
    const seat = (seats() ?? []).find((s) => s.osnProfileId === profileId);
    return seat ? seatName(seat) : profileId;
  };

  const loadSeats = async (): Promise<HostSeat[]> => {
    const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/hosts")));
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`Failed to load the wedding's people (${res.status})`);
    const { hosts } = (await res.json()) as { hosts: HostSeat[] };
    for (const seat of hosts) seat.role = normaliseWeddingRole(seat.role);
    return hosts;
  };

  /** Read the seats unless they are fresh; a failure says so in the dialog. */
  function ensureSeats(): void {
    setSeatsFailed(false);
    ensureHostsLoaded(props.weddingId, loadSeats).catch((err: unknown) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setSeatsFailed(true);
    });
  }

  function ask(which: Asking): void {
    if (working() || props.busy) return;
    batch(() => {
      setChosen("");
      setAsking(which);
    });
    if (which !== "disconnect") ensureSeats();
  }

  /** The dialog closed, from any cause: run what was waiting on it, once. */
  function closed(): void {
    setAsking(null);
    const next = afterClose;
    afterClose = null;
    next?.();
  }

  /** Run `next` once no dialog is open: now, or when the open one has closed. */
  function whenClosed(next: () => void): void {
    if (asking() === null) return next();
    afterClose = next;
    setAsking(null);
  }

  /**
   * Retire the account. `handTo` names the owner a holder hands money gifts
   * to. Answers whether it was retired; every refusal is said here.
   */
  async function retire(handToId: string | null, done: string): Promise<boolean> {
    setWorking(true);
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/registry/stripe/retire")), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handTo: handToId }),
      });
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        settings?: RegistrySettings;
      } | null;
      if (res.ok && body?.settings) {
        props.onRetired();
        props.onSettings(body.settings);
        // The holder's seat may leave, step down or be removed now: the
        // co-host panel and the checklist read the seats again.
        invalidateHosts(props.weddingId);
        haptic("commit");
        toast.success(done);
        return true;
      }
      haptic("reject");
      if (body?.error === "stripe_account_changed") {
        if (body.settings) props.onSettings(body.settings);
        whenClosed(() => {});
        toast.error(
          "This wedding’s Stripe account changed while you had this open. It’s showing now.",
        );
        return false;
      }
      if (body?.error === "handover_not_owner") {
        const name = handToId ? nameOf(handToId) : "That person";
        setChosen("");
        invalidateHosts(props.weddingId);
        ensureSeats();
        toast.error(`${name} isn’t an owner of this wedding any more. Choose someone else.`);
        return false;
      }
      whenClosed(() => {});
      toast.error(
        res.status === 403
          ? "Only an owner can change the account money gifts are paid into. Reload the page to see your current access."
          : res.status === 429
            ? "Too many tries for now. Wait a minute, then try again."
            : "Couldn’t change the Stripe account just now. Try again in a moment.",
      );
      return false;
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return false;
      }
      haptic("reject");
      toast.error("Couldn’t change the Stripe account just now. Is the API running?");
      return false;
    } finally {
      setWorking(false);
    }
  }

  /** The open dialog's commit. */
  async function confirm(): Promise<void> {
    const which = asking();
    if (which === null || working()) return;
    if (which === "handover") {
      const to = handTo();
      if (to === "") return;
      const name = nameOf(to);
      if (
        await retire(
          to,
          `Money gifts are handed to ${name}. Guests can’t give money until they connect an account.`,
        )
      ) {
        whenClosed(() => props.onNext("focus"));
      }
      return;
    }
    if (which === "disconnect") {
      if (
        await retire(
          null,
          "Your Stripe account is disconnected. Guests can’t give money until an owner connects an account.",
        )
      ) {
        whenClosed(() => props.onNext("focus"));
      }
      return;
    }
    if (await retire(null, "This wedding no longer uses that Stripe account. Connect yours.")) {
      whenClosed(() => props.onNext("connect"));
    }
  }

  /**
   * "Use your own account", for an account no current owner holds. No dialog:
   * money gifts are already closed. The settings are read first, so a holder
   * who is an owner again is never replaced without the replace dialog.
   */
  async function useOwn(): Promise<void> {
    if (working() || props.busy) return;
    setWorking(true);
    let fresh: RegistrySettings | null;
    try {
      fresh = await props.readSettings();
    } finally {
      setWorking(false);
    }
    if (!fresh) {
      haptic("reject");
      toast.error("Couldn’t check the Stripe account just now. Try again in a moment.");
      return;
    }
    props.onSettings(fresh);
    if (!fresh.stripeConnected) {
      haptic("reject");
      toast.error("This wedding has no Stripe account now. Connect one to take gifts again.");
      return;
    }
    if (fresh.payoutHolderAbsent !== true) {
      haptic("reject");
      toast.error(
        "The person who connected this account is an owner again, so it takes gifts again. To replace it, use Replace with my own account.",
      );
      return;
    }
    if (await retire(null, "This wedding no longer uses that Stripe account. Connect yours.")) {
      props.onNext("connect");
    }
  }

  const locked = () => working() || props.busy;

  return (
    <>
      <Switch>
        <Match when={props.mode === "holder"}>
          <Button
            type="button"
            variant="outline"
            disabled={locked()}
            onClick={() => ask("handover")}
          >
            Hand money gifts to another owner
          </Button>
          <Button
            type="button"
            variant="quiet"
            disabled={locked()}
            onClick={() => ask("disconnect")}
          >
            Disconnect
          </Button>
        </Match>
        <Match when={props.mode === "other"}>
          <Button type="button" variant="quiet" disabled={locked()} onClick={() => ask("replace")}>
            Replace with my own account
          </Button>
        </Match>
        <Match when={props.mode === "absent"}>
          <Button type="button" variant="outline" disabled={locked()} onClick={() => void useOwn()}>
            {working() ? "Checking…" : "Use your own account"}
          </Button>
        </Match>
      </Switch>

      {/* Kept mounted across the close so the exit plays; `shown` keeps the
          words on screen through it. `onClose` is the one place a dialog is
          dropped, and the one place what follows a retire runs. */}
      <Modal
        open={asking() !== null}
        onClose={closed}
        labelledBy={ids.title}
        dismissable={!working()}
        class="w-full max-w-md"
      >
        <Show when={shown()}>
          {(which) => (
            <div class="flex flex-col gap-4">
              <h2
                id={ids.title}
                class="font-display text-text text-ui-md leading-ui-tight font-light"
              >
                {DIALOG[which()].title}
              </h2>

              <Show when={which() === "handover"}>
                <HandOverChoice
                  owners={otherOwners()}
                  loading={seats() === null && !seatsFailed()}
                  failed={seatsFailed()}
                  chosen={chosen()}
                  onChoose={setChosen}
                  chooseId={ids.choose}
                  disabled={working()}
                />
              </Show>

              {/* The replace names the holder once the seats have answered. */}
              <p class="font-body text-text-muted text-ui-sm leading-ui-normal wrap-anywhere">
                {which() === "replace"
                  ? `${props.holderId && seats() ? nameOf(props.holderId) : "The person who connected it"} ${DIALOG.replace.body}`
                  : DIALOG[which()].body}
              </p>

              <div class="flex flex-wrap justify-end gap-2">
                <Button
                  variant="quiet"
                  type="button"
                  disabled={working()}
                  onClick={() => setAsking(null)}
                >
                  Cancel
                </Button>
                {/* A hand-over commits only to an owner it can name. */}
                <Show when={which() !== "handover" || otherOwners().length > 0}>
                  <Button
                    variant={which() === "disconnect" ? "danger" : "primary"}
                    type="button"
                    disabled={working()}
                    aria-disabled={which() === "handover" && handTo() === "" ? "true" : undefined}
                    aria-describedby={
                      which() === "handover" && handTo() === "" ? ids.choose : undefined
                    }
                    onClick={() => void confirm()}
                  >
                    {working() ? DIALOG[which()].pressed : DIALOG[which()].commit}
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Modal>
    </>
  );
}

/**
 * Who a hand-over names: the one other owner, by name; several, as a choice
 * with nothing chosen; none, and what to do instead.
 */
function HandOverChoice(props: {
  owners: HostSeat[];
  loading: boolean;
  failed: boolean;
  chosen: string;
  onChoose: (profileId: string) => void;
  chooseId: string;
  disabled: boolean;
}) {
  const textClass = "font-body text-text text-ui-sm leading-ui-normal";
  const legendId = createUniqueId();
  return (
    <Switch>
      <Match when={props.failed}>
        <Notice tone="danger" size="sm" alert>
          Couldn’t load the wedding’s owners. Close this and try again.
        </Notice>
      </Match>
      <Match when={props.loading}>
        <Loading label="Finding the wedding’s owners…" />
      </Match>
      <Match when={props.owners.length === 0}>
        <p class={textClass}>
          There’s no other owner to hand them to. Make someone an owner in Co-hosts first, or
          disconnect your account.
        </p>
      </Match>
      <Match when={props.owners.length === 1}>
        <p class={`${textClass} wrap-anywhere`}>
          They go to {seatName(props.owners[0]!)}, who connects an account of their own to take
          gifts again.
        </p>
      </Match>
      <Match when={props.owners.length > 1}>
        {/* The radio group carries the name, from the legend, as the panel's
            other choices do; the fieldset takes no role, so it is said once. */}
        <fieldset role="none" class="flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend id={legendId} class={`${textClass} mb-1`}>
            Which owner takes them on?
          </legend>
          <RadioGroup
            box="native"
            orientation="vertical"
            value={props.chosen}
            onChange={props.onChoose}
            disabled={props.disabled}
            aria-labelledby={legendId}
          >
            <For each={props.owners}>
              {(owner) => (
                <RadioGroupItem
                  value={owner.osnProfileId}
                  label={<span class="wrap-anywhere">{seatName(owner)}</span>}
                />
              )}
            </For>
          </RadioGroup>
          <Show when={props.chosen === ""}>
            <p id={props.chooseId} class="font-body text-text-muted text-ui-sm leading-ui-normal">
              Choose an owner first.
            </p>
          </Show>
        </fieldset>
      </Match>
    </Switch>
  );
}
