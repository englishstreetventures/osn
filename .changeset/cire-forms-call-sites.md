---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
---

Every cire checkbox and radio but the radio cards and the gift panel's hidden choice radios is `@shared/ui`'s `Checkbox` or `RadioGroup` drawing the browser's own box: labels in body ink — consent statements included — 8px from the box, radios 16px apart in a row and 8px in a column, a consent's note under it and the privacy choices' summaries inside their labels. The run-time radios lose their brand ink, and the organiser's email attestation sits in the accent `Notice`.

Every portal form field takes the shared `form` or `form-compact` size and every filter `sm`, so `FORM_FIELD_CLASS` and `FILTER_FIELD_CLASS` are gone; the date picker's trigger, the read-only date and invite-link boxes and the dietary picker's trigger are 34px too. The guest site's and the demo's twelve text fields are the shared ink fill at the touch size: 46px with 16px type on a phone, 44px from 640px, the code in centred capitals and the gift amount centred. The four file pickers are `FileInput`, the invite picture's named and its row's buttons 34px; the guest and marketing sites leave its rules out of their CSS.
