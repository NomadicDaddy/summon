# Record format

Records use `version: 3`, an `expertise` string, a `provider` of `claude`, `codex`, `grok`, or `kilo`, and a single
`sessions` array. An optional `domain` string names the areas that record is the primary for; records
written without it remain valid. Notes are not part of the record: they live in `<name>.md` beside it.

Version 1 and 2 records are rejected rather than converted. To convert a version 2 record, set
`version` to `3`, rename its `notes` field to `expertise`, and move anything that reads as running
notes out of that field into `<name>.md`.
Version 1 records are rejected, not automatically assigned a CLI. To convert an old record, keep a
backup, choose its provider, set `version` to `2`, and replace the old sessions map with that provider's
session array. Preserve the other fields and every session entry. If both providers have history,
split them into separately named records before converting; do not discard either history.
