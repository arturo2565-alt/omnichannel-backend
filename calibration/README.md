# CAL-001 — Calibration Foundation

**Status:** pinned contract and isolated engine on `genesis/staging`. Not imported by the Nest application. No HTTP route.

The versioned source of truth is `arturo2565-alt/pegazuz-calibration-data` at `35818ba9f3fb4ee8beecea1f7d09f7e2e4022cfd`:

- `schema/case-v1.schema.json` → `calibration/schema.json`
- `schema/photo-v1.schema.json` → `calibration/photo-v1.schema.json`

`src/calibration/calibration-engine.ts` validates authorized human quotes against that contract. It does not write to the private repository unless a caller supplies a credential, and this tree does not supply one.

This branch contains no business quotes or customer images. The repository is currently **public**; do not commit commercial prices, original photos, or personal data here.

## Storage contract
- Case records will use stable `case_id` identifiers, and each source event a stable `source_case_key`.
- One case contains one or more line items. Similar vehicle/price combinations do not imply duplication.
- Repeated source events are idempotent; a correction targets its existing case and retains commit history.
- Human-confirmed quotes are observations, not automatically executable pricing rules.
- Do not create production price rules or update CanonicalQuoteV1 from this dataset without explicit validation.
- Photo references must target private, persistent storage and avoid customer identifiers.
- Writes must read latest file SHA, update with that SHA, and re-fetch for verification.

## Gates before storing real cases
1. Provision restricted-access repository/storage and verify access.
2. Validate schema, uniqueness and correction workflows using synthetic records.
3. Confirm private photo storage and retention rules.
4. Re-read persisted records after each batch and capture commit SHA.

No runtime integration, price changes, or production migrations are included in CAL-001.
