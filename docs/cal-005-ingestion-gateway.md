# CAL-005 — Server-side calibration ingestion (prototype)

Status: **source code only**, preserved on `genesis/staging`. NOT deployed, NOT attached to NestJS, NOT authorized for production, no real case written.

## Why
GitHub connector writes from ChatGPT returned an OpenAI security-control block while reads succeeded. This does **not** demonstrate that GitHub itself denied the call. Do not retry blocked writes or claim the cause is known.

## What is implemented
- A standalone TypeScript server-side writer for the private repository `arturo2565-alt/pegazuz-calibration-data`.
- GitHub Contents API requests with a server-held credential; no credentials in ChatGPT prompts.
- Stable case/source keys with conflict checking, idempotent replay of indexed source keys.
- GitHub file SHA optimistic concurrency and explicit partial state when index write fails.
- Unit-test drafts for repeated keys and case-ID conflicts.

## Required before use
1. Execute Nest/TypeScript build and Jest; review and correct any failures.
2. Replace general token with short-lived, least-privilege GitHub App installation authorization, scoped to the private repository.
3. Add proper DTO JSON-schema validation, body limits, per-tenant authorization, audit trail and no-sensitive-data logging.
4. Add atomic multi-file updates or robust reconciliation with concurrency tests; avoid a case/index mismatch.
5. Add protected NestJS route in *staging* only, disabled by default. Do not reuse end-user JWT as unattended ChatGPT credentials.
6. Establish permitted transport of text plus binary attachments from the ChatGPT **AutoFix project Cotizador**; a project folder/instruction by itself cannot invoke our endpoint.
7. Add private Cloudinary upload with validated retrieval/checksum before marking archived.
8. End-to-end acceptance: real tool -> staging endpoint -> GitHub index + case -> Cloudinary image -> re-fetch. No production or CanonicalQuoteV1 changes.

## Pending
AF-000002 was proposed by Cotizador, but no write has been confirmed. Its photograph is not archived.
