# Square Client Refactor Plan

Plan to extend `services/square/square-client.js` into a richer shared
abstraction and migrate the ~20 call sites. Scope: internal refactor only;
no change to Square API behavior, retry semantics, or token handling.

## Section 1 — Call-Site Inventory

| File | Methods Used | Behavioral Dependencies | Complexity |
|------|--------------|-------------------------|------------|
| services/square/index.js | full module re-export | Public barrel for `./square-client`; any shape change ripples out | Complex |
| services/square/api.js | getMerchantToken, makeSquareRequest, generateIdempotencyKey | Thin facade over client; heavy downstream consumers | Complex |
| services/square/square-inventory.js | getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey | Inventory count adjustments; idempotency required | Complex |
| services/square/square-catalog-sync.js | getMerchantToken, makeSquareRequest, sleep | Long-running batched catalog sync; custom retry pacing | Complex |
| services/square/square-custom-attributes.js | getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey | Upsert attributes; version conflicts common | Medium |
| services/square/square-pricing.js | getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey | Batch price updates; version-mismatch sensitive | Medium |
| services/square/square-vendors.js | getMerchantToken, makeSquareRequest, sleep | Vendor CRUD; relies on non-retryable error codes | Medium |
| services/square/square-velocity.js | getMerchantToken, makeSquareRequest, sleep | Order search pagination; sleep between pages | Medium |
| services/square/square-diagnostics.js | getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey | Read-heavy probe endpoints; tolerant of errors | Medium |
| services/square/square-locations.js | getMerchantToken, makeSquareRequest | Simple list/get locations | Simple |
| services/square/square-location-preflight.js | makeSquareRequest, sleep | Receives token from caller; no token fetch | Simple |
| services/square/inventory-receive-sync.js | makeSquareRequest, sleep | Token passed in; batch inventory recv | Medium |
| services/vendor/catalog-create-service.js | getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey | Creates catalog objects; idempotency critical | Complex |
| services/vendor/match-suggestions-service.js | getMerchantToken, makeSquareRequest, generateIdempotencyKey | Suggestion write-back; idempotent upserts | Medium |
| services/vendor/vendor-query-service.js | getMerchantToken, makeSquareRequest (lazy require) | Lazy-required inside function to avoid cycle | Medium |
| services/catalog/catalog-health-service.js | getMerchantToken, makeSquareRequest | Read-only health probes | Simple |
| services/catalog/location-health-service.js | getMerchantToken, makeSquareRequest | Read-only health probes | Simple |
| utils/square-webhooks.js | generateIdempotencyKey (only) | Uses only the key helper; no HTTP | Simple |
| utils/square-subscriptions.js | makeSquareRequest, generateIdempotencyKey | Subscription CRUD; caller supplies token | Medium |
| scripts/combined-order-backfill.js | getMerchantToken, makeSquareRequest, sleep | One-off backfill script; long-running | Medium |
