# @shared/legal

## 0.0.1

### Patch Changes

- 7d3bdbf: Stop the draft banner from going out from under a field that is still a token.

  `LEGAL_DETAILS_PENDING` is derived from three identity fields — the entity name,
  the postal address and the contact email. Every page gated its draft banner on
  that flag alone, including the three `@cire/landing` pages that also publish the
  merchant of record, and the privacy notice that also publishes the retention
  sentence. Both of those are still `{{PLACEHOLDER}}`.

  So filling in the operator's name would have taken the banner off all three
  pages while they went on printing a live `{{MERCHANT_OF_RECORD}}` to the reader,
  highlighted in gold and no longer labelled a draft. Filling in the first field
  was enough to publish the unfilled ones. This is the failure `pendingAny` was
  written for, and nothing ever called it.

  `pendingAny` is now `draftPending`, which checks the identity half itself and
  takes the extra fields the page publishes on top:

  ```ts
  const draft = draftPending(
    LEGAL_ENTITY.merchantOfRecord,
    LEGAL_ENTITY.accountDataRetention
  );
  ```

  All thirteen pages pass every field they name, so no page can go un-flagged for
  a detail it has not filled in.

  Also on the app frontends: the dotted underline marking an unfilled detail read
  the page-wide flag, so it would have marked a filled entity name as pending
  while some other field was outstanding. It now checks the field it underlines.
