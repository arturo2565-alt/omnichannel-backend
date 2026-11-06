# CAL-004B — Private image archive prototype

## Scope
Preserved on `genesis/staging` from `cal/cal-004b-private-images`. Experimental only.

Files:
- `src/calibration/calibration-image-archive.service.ts`
- `src/calibration/calibration-image-archive.service.spec.ts`

This is **not a deployed feature**: the new service is not imported into `AppModule`, and no controller/endpoint has been created. The ChatGPT AutoFix Cotizador cannot upload images with this code alone.

## Implemented in prototype
- Reject empty images, unsupported file signatures and >5 MiB payloads.
- Detect JPEG/PNG/WEBP signatures and compute SHA-256.
- Validate tenant and case identifiers before constructing Cloudinary public IDs.
- Request `type: authenticated` with deterministic per-case asset ID and `overwrite: false`.
- Return private archive metadata, not a public delivery URL.
- Throw if Cloudinary does not confirm authenticated asset response.

## Must complete before activation
1. Run build/Jest and integrate mocked Cloudinary tests; verify real upload and authenticated retrieval on staging.
2. Validate actual image decoding, pixel bounds and malicious/invalid images, rather than only magic headers.
3. Add authenticated/authorized endpoint: derive tenantId from trusted identity, never from untrusted request body.
4. Verify content integrity by authorized re-download and checksum (Cloudinary metadata alone is not sufficient).
5. Add durable manifest / idempotent registration and recovery of partial failures. GitHub case references must be updated only after successful archive verification.
6. Define privacy retention policy, redact/exclude plates or faces as required, and restrict access by tenant.
7. Validate a supported attachment transfer path from the ChatGPT AutoFix folder Cotizador. Never put Cloudinary secrets in instructions.
8. Confirm Cloudinary credentials and secure delivery in staging without logging secrets.
9. Do not route existing chat uploads through this prototype or change CanonicalQuoteV1.

## Current real calibration case
AF-000001: pricing in private GitHub; original photo **not archived**.
