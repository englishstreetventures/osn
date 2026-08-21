import { Avatar, AvatarFallback } from "@osn/ui/ui/avatar";
import { Badge } from "@osn/ui/ui/badge";
import { Button } from "@osn/ui/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@osn/ui/ui/card";
import { Checkbox } from "@osn/ui/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@osn/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { OtpInput } from "@osn/ui/ui/otp-input";
import { Popover, PopoverContent, PopoverTrigger } from "@osn/ui/ui/popover";
import { RadioGroup, RadioGroupItem } from "@osn/ui/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@osn/ui/ui/tabs";
import { Textarea } from "@osn/ui/ui/textarea";
import { UsernameInput } from "@osn/ui/ui/username-input";
import { createSignal, type JSX } from "solid-js";

export const meta = { title: "osn/ui", layout: "padded" as const };

/**
 * One entry in the catalogue: what it is called, what to import, and the thing
 * itself. Not exported — every export in a story file is read as a story.
 */
function Entry(props: { name: string; from: string; children: JSX.Element }) {
  return (
    <section class="border-border flex flex-col gap-3 border-t py-6">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="text-title font-semibold">{props.name}</h2>
        <code class="text-meta text-subtle">{props.from}</code>
      </div>
      <div class="flex flex-wrap items-center gap-3">{props.children}</div>
    </section>
  );
}

/**
 * Every component `@osn/ui` exports, on one page, in one state each. This is
 * the "what do we already have" view — for a component's full range of
 * variants and states, open its own story.
 */
export const Everything = () => {
  const [checked, setChecked] = createSignal(true);
  const [visibility, setVisibility] = createSignal("friends");
  const [handle, setHandle] = createSignal("ada");
  const [code, setCode] = createSignal("1234");

  return (
    <div class="mx-auto max-w-3xl pb-16">
      <header class="pb-2">
        <h1 class="text-display font-semibold">@osn/ui</h1>
        <p class="text-body text-muted-foreground mt-1">
          Fifteen components, shared across every surface on the network. Each row shows one state —
          the per-component stories carry the rest.
        </p>
      </header>

      <Entry name="Button" from="@osn/ui/ui/button">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Entry>

      <Entry name="Badge" from="@osn/ui/ui/badge">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="outline">Outline</Badge>
      </Entry>

      <Entry name="Avatar" from="@osn/ui/ui/avatar">
        <Avatar class="size-8">
          <AvatarFallback>AC</AvatarFallback>
        </Avatar>
        <Avatar class="size-10">
          <AvatarFallback>MB</AvatarFallback>
        </Avatar>
        <Avatar class="size-14">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      </Entry>

      <Entry name="Card" from="@osn/ui/ui/card">
        <Card class="w-72">
          <CardHeader>
            <CardTitle>Rooftop, Friday</CardTitle>
            <CardDescription>Carlton North · 7:00pm</CardDescription>
          </CardHeader>
          <CardContent>
            <p class="text-body text-muted-foreground">Header, content, footer — all optional.</p>
          </CardContent>
        </Card>
      </Entry>

      <Entry name="Input · Label" from="@osn/ui/ui/input · /ui/label">
        <div class="flex w-64 flex-col gap-1.5">
          <Label for="overview-name">Display name</Label>
          <Input id="overview-name" placeholder="Ada Lovelace" />
        </div>
      </Entry>

      <Entry name="Textarea" from="@osn/ui/ui/textarea">
        <Textarea class="w-64" rows={3} placeholder="A sentence or two." />
      </Entry>

      <Entry name="Checkbox" from="@osn/ui/ui/checkbox">
        <Checkbox checked={checked()} onChange={setChecked} label="Email me about replies" />
      </Entry>

      <Entry name="RadioGroup" from="@osn/ui/ui/radio-group">
        <RadioGroup value={visibility()} onChange={setVisibility}>
          <RadioGroupItem value="public" label="Public" />
          <RadioGroupItem value="friends" label="Friends" />
          <RadioGroupItem value="private" label="Private" />
        </RadioGroup>
      </Entry>

      <Entry name="UsernameInput" from="@osn/ui/ui/username-input">
        <div class="w-64">
          <UsernameInput value={handle()} onInput={setHandle} status="available" />
        </div>
      </Entry>

      <Entry name="OtpInput" from="@osn/ui/ui/otp-input">
        <OtpInput value={code()} onChange={setCode} />
      </Entry>

      <Entry name="Tabs" from="@osn/ui/ui/tabs">
        <Tabs defaultValue="going" class="w-full">
          <TabsList>
            <TabsTrigger value="going">Going</TabsTrigger>
            <TabsTrigger value="maybe">Maybe</TabsTrigger>
          </TabsList>
          <TabsContent value="going">
            <p class="text-body text-muted-foreground">Twelve people are going.</p>
          </TabsContent>
          <TabsContent value="maybe">
            <p class="text-body text-muted-foreground">Four are undecided.</p>
          </TabsContent>
        </Tabs>
      </Entry>

      {/* The three portalled components. Their content leaves the preview pane
          when opened — see the note on the overlays story. */}
      <Entry name="Dialog" from="@osn/ui/ui/dialog">
        <Dialog>
          <DialogTrigger as={Button} variant="outline">
            Open dialog
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Leave this event?</DialogTitle>
            </DialogHeader>
            <div class="p-4">
              <DialogDescription>Your RSVP is removed and the host is told.</DialogDescription>
            </div>
          </DialogContent>
        </Dialog>
      </Entry>

      <Entry name="DropdownMenu" from="@osn/ui/ui/dropdown-menu">
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="outline">
            Account
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuItem>Settings</DropdownMenuItem>
            <DropdownMenuItem>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Entry>

      <Entry name="Popover" from="@osn/ui/ui/popover">
        <Popover>
          <PopoverTrigger as={Button} variant="ghost">
            What is a handle?
          </PopoverTrigger>
          <PopoverContent>The name people find you by, across every app.</PopoverContent>
        </Popover>
      </Entry>
    </div>
  );
};
