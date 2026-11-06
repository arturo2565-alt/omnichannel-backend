# CAL-001 — Calibration Foundation

**Status:** schema-only scaffold on `genesis/staging`. **Real calibration cases: 0**. Not imported by the Nest application.

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
