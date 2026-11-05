import SegmentedTabs from "@cire/ui/segmented-tabs";

/**
 * The portal's two views, as one control: `@cire/ui`'s glass strip, the
 * owner's one look for every segmented control in the portals.
 *
 * A strip with a single travelling highlight says the two are a choice between
 * each other, and keeps "which view am I in" apart from "leave", which is in
 * the profile menu: two views in a row beside a sign-out button would be the
 * same kind of thing in the same place, told apart only by a colour.
 *
 * `current`, not `tabs`: these swap the whole page and push history, and the
 * ARIA tab pattern promises a panel that is a sibling of the strip plus
 * arrow-key roving focus over it. What this actually is, is two
 * links-shaped-as-buttons — so it is announced as what it is, with
 * `aria-current` naming the one you are on.
 */

export type VendorView = "listings" | "enquiries";

const TABS: ReadonlyArray<{ value: VendorView; label: string }> = [
  { value: "listings", label: "Listings" },
  { value: "enquiries", label: "Enquiries" },
];

export default function ViewTabs(props: {
  value: VendorView;
  onChange: (next: VendorView) => void;
}) {
  return (
    <SegmentedTabs
      items={TABS}
      value={props.value}
      onChange={props.onChange}
      label="Views"
      semantics="current"
      class="shrink-0"
    />
  );
}
