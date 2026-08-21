import { Checkbox } from "@osn/ui/ui/checkbox";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { OtpInput, type OtpStatus } from "@osn/ui/ui/otp-input";
import { RadioGroup, RadioGroupItem } from "@osn/ui/ui/radio-group";
import { Textarea } from "@osn/ui/ui/textarea";
import { UsernameInput, type UsernameInputStatus } from "@osn/ui/ui/username-input";
import { createSignal } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";

export const meta = { title: "osn/ui/forms", layout: "padded" as const };

export const TextFields = () => (
  <div class="flex max-w-sm flex-col gap-5">
    <div class="flex flex-col gap-1.5">
      <Label for="lab-name">Display name</Label>
      <Input id="lab-name" placeholder="Ada Lovelace" />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="lab-email">Email</Label>
      <Input id="lab-email" type="email" value="ada@example.com" />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="lab-disabled">Disabled</Label>
      <Input id="lab-disabled" value="Locked" disabled />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="lab-bio">Bio</Label>
      <Textarea id="lab-bio" rows={4} placeholder="A sentence or two." />
    </div>
  </div>
);

export const Choices = () => {
  const [subscribed, setSubscribed] = createSignal(true);
  const [visibility, setVisibility] = createSignal("friends");

  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">Checkbox</span>
        <Checkbox checked={subscribed()} onChange={setSubscribed} label="Email me about replies" />
        <Checkbox checked={false} label="Unchecked" />
        <p class="text-meta text-subtle">checked: {String(subscribed())}</p>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">Radio group</span>
        <RadioGroup value={visibility()} onChange={setVisibility}>
          <RadioGroupItem value="public" label="Public" />
          <RadioGroupItem value="friends" label="Friends" />
          <RadioGroupItem value="private" label="Private" />
        </RadioGroup>
        <p class="text-meta text-subtle">value: {visibility()}</p>
      </div>
    </div>
  );
};

interface UsernameArgs extends StoryArgs {
  status: UsernameInputStatus;
  invalidMessage: string;
}

/**
 * Every availability state the handle field can be in. `status` is the
 * caller's to drive — the component does no checking of its own — so the
 * control here stands in for a debounced lookup.
 */
export const Username: Story<UsernameArgs> = {
  args: { status: "available", invalidMessage: "Letters, numbers and underscores only." },
  controls: {
    status: {
      kind: "select",
      options: ["idle", "checking", "available", "taken", "invalid", "error"],
    },
  },
  render: (args) => {
    const [value, setValue] = createSignal("ada");
    return (
      <div class="max-w-sm">
        <UsernameInput
          value={value()}
          onInput={setValue}
          status={args.status}
          invalidMessage={args.invalidMessage}
        />
      </div>
    );
  },
};

interface OtpArgs extends StoryArgs {
  status: OtpStatus;
  disabled: boolean;
}

/**
 * The six-box verification code. `verifying` and `accepted` disable the boxes
 * on their own; `error` re-focuses the first one so a retry can just be typed.
 */
export const Otp: Story<OtpArgs> = {
  args: { status: "idle", disabled: false },
  controls: {
    status: { kind: "select", options: ["idle", "error", "verifying", "accepted"] },
  },
  render: (args) => {
    const [code, setCode] = createSignal("12");
    return (
      <div class="flex flex-col gap-3">
        <OtpInput value={code()} onChange={setCode} status={args.status} disabled={args.disabled} />
        <p class="text-meta text-subtle">value: {code() || "(empty)"}</p>
      </div>
    );
  },
};
