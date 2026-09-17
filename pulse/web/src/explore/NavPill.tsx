import type { JSX } from "solid-js";

/**
 * A control in the explore nav's right-hand cluster: sign in, notifications,
 * host an event.
 *
 * The three were written out three times, and the copies had drifted in the two
 * ways copies do. The sign-in pill and the Host pill are the same filled coral
 * button, except one had `hover:opacity-90` and the other had no hover state at
 * all. And both reached the coral through an inline
 * `style={{ background: "var(--pulse-accent)" }}` plus a
 * `text-[var(--pulse-accent-fg)]` arbitrary value — the brand colour was not in
 * the Tailwind theme, so there was no utility to write. It is now
 * (`app.css`'s `@theme inline` block), and this component is what that bought.
 */
export type NavPillTone = "accent" | "outline";

const TONE = {
  /** The brand coral, for the one action the nav is asking for. */
  accent: "bg-pulse-accent text-pulse-accent-fg border-transparent hover:opacity-90",
  /** Everything else in the cluster: present, not asking. */
  outline: "border-border bg-card hover:bg-secondary",
} satisfies Readonly<Record<NavPillTone, string>>;

export function NavPill(
  props: {
    tone: NavPillTone;
    children: JSX.Element;
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "type" | "children">,
) {
  const { tone, children, ...rest } = props;
  return (
    <button
      type="button"
      class={`text-ui-sm relative inline-flex h-9 items-center gap-2 rounded-full border px-3.5 font-medium ${TONE[tone]}`}
      {...rest}
    >
      {children}
    </button>
  );
}
