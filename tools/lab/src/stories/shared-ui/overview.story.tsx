import { Avatar, AvatarFallback } from "@shared/ui/ui/avatar";
import { Badge } from "@shared/ui/ui/badge";
import { Button } from "@shared/ui/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shared/ui/ui/card";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Chip } from "@shared/ui/ui/chip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@shared/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Meter } from "@shared/ui/ui/meter";
import { Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { OtpInput } from "@shared/ui/ui/otp-input";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { Select } from "@shared/ui/ui/select";
import { Stat } from "@shared/ui/ui/stat";
import { Table, Td, Th } from "@shared/ui/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/ui/ui/tabs";
import { Textarea } from "@shared/ui/ui/textarea";
import { UsernameInput } from "@shared/ui/ui/username-input";
import { createSignal, type JSX } from "solid-js";

export const meta = { title: "shared/ui", layout: "padded" as const };

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
 * Every component `@shared/ui` exports, on one page, in one state each. This is
 * the "what do we already have" view — for a component's full range of
 * variants and states, open its own story.
 */
export const Everything = () => {
  const [checked, setChecked] = createSignal(true);
  const [visibility, setVisibility] = createSignal("friends");
  const [handle, setHandle] = createSignal("ada");
  const [code, setCode] = createSignal("1234");
  const [modalOpen, setModalOpen] = createSignal(false);

  return (
    <div class="mx-auto max-w-3xl pb-16">
      <header class="pb-2">
        <h1 class="text-display font-semibold">@shared/ui</h1>
        <p class="text-body text-muted-foreground mt-1">
          Every component shared across the surfaces on the network, each row in one state — the
          per-component stories carry the rest. Everything below is written against the token
          contract, so the light · dark toggle re-themes all of it at once.
        </p>
      </header>

      <Entry name="Button" from="@shared/ui/ui/button">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Entry>

      <Entry name="Badge" from="@shared/ui/ui/badge">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="outline">Outline</Badge>
      </Entry>

      <Entry name="Avatar" from="@shared/ui/ui/avatar">
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

      <Entry name="Card" from="@shared/ui/ui/card">
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

      <Entry name="Input · Label" from="@shared/ui/ui/input · /ui/label">
        <div class="flex w-64 flex-col gap-1.5">
          <Label for="overview-name">Display name</Label>
          <Input id="overview-name" placeholder="Ada Lovelace" />
        </div>
      </Entry>

      <Entry name="Textarea" from="@shared/ui/ui/textarea">
        <Textarea class="w-64" rows={3} placeholder="A sentence or two." />
      </Entry>

      <Entry name="Checkbox" from="@shared/ui/ui/checkbox">
        <Checkbox checked={checked()} onChange={setChecked} label="Email me about replies" />
      </Entry>

      <Entry name="RadioGroup" from="@shared/ui/ui/radio-group">
        <RadioGroup value={visibility()} onChange={setVisibility}>
          <RadioGroupItem value="public" label="Public" />
          <RadioGroupItem value="friends" label="Friends" />
          <RadioGroupItem value="private" label="Private" />
        </RadioGroup>
      </Entry>

      <Entry name="UsernameInput" from="@shared/ui/ui/username-input">
        <div class="w-64">
          <UsernameInput value={handle()} onInput={setHandle} status="available" />
        </div>
      </Entry>

      <Entry name="OtpInput" from="@shared/ui/ui/otp-input">
        <OtpInput value={code()} onChange={setCode} />
      </Entry>

      <Entry name="Tabs" from="@shared/ui/ui/tabs">
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

      <Entry name="Field" from="@shared/ui/ui/field">
        <div class="w-72">
          <Field label="Wedding name" hint="Shown to guests">
            {(field) => <Input {...field} value="Ada & Grace" />}
          </Field>
        </div>
      </Entry>

      <Entry name="Select" from="@shared/ui/ui/select">
        <Select class="w-64">
          <option>Australia/Sydney</option>
          <option>Pacific/Auckland</option>
        </Select>
      </Entry>

      <Entry name="Notice" from="@shared/ui/ui/notice">
        <div class="w-full max-w-md">
          <Notice tone="warn">Three guests have no email address.</Notice>
        </div>
      </Entry>

      <Entry name="Chip" from="@shared/ui/ui/chip">
        <Chip>draft</Chip>
        <Chip tone="success">live</Chip>
        <Chip tone="pending">awaiting reply</Chip>
        <Chip tone="accent">quoted</Chip>
      </Entry>

      <Entry name="Stat" from="@shared/ui/ui/stat">
        <Stat value="84" label="Replied" hint="of 120 invited" />
      </Entry>

      <Entry name="Meter" from="@shared/ui/ui/meter">
        <div class="w-64">
          <Meter value={68} max={100} label="Budget spent" />
        </div>
      </Entry>

      <Entry name="EmptyState" from="@shared/ui/ui/empty-state">
        <div class="w-full max-w-md">
          <EmptyState title="No guests yet" description="Add one, or import a spreadsheet." />
        </div>
      </Entry>

      <Entry name="Table" from="@shared/ui/ui/table">
        <Table label="Guests">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Reply</Th>
              <Th align="center">Seats</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>Ada Lovelace</Td>
              <Td>Going</Td>
              <Td numeric>2</Td>
            </tr>
            <tr>
              <Td>Grace Hopper</Td>
              <Td>Awaiting</Td>
              <Td numeric>1</Td>
            </tr>
          </tbody>
        </Table>
      </Entry>

      {/* `Modal` is a `<dialog>` in the top layer rather than a portal, so
          unlike the three below it needs no z-index and cannot be trapped by a
          transformed ancestor. It still leaves the preview pane when open. */}
      <Entry name="Modal" from="@shared/ui/ui/modal">
        <Button variant="outline" onClick={() => setModalOpen(true)}>
          Open modal
        </Button>
        <Modal open={modalOpen()} onClose={() => setModalOpen(false)} label="Leave this event?">
          <h2 class="text-title font-semibold">Leave this event?</h2>
          <p class="text-body text-muted-foreground mt-2">
            Your RSVP is removed and the host is told.
          </p>
          <div class="mt-6 flex justify-end">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Stay
            </Button>
          </div>
        </Modal>
      </Entry>

      {/* The three portalled components. Their content leaves the preview pane
          when opened — see the note on the overlays story. */}
      <Entry name="Dialog" from="@shared/ui/ui/dialog">
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

      <Entry name="DropdownMenu" from="@shared/ui/ui/dropdown-menu">
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

      <Entry name="Popover" from="@shared/ui/ui/popover">
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
