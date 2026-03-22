# Section 13: COMPLIANCE

**Rating: NEEDS WORK**

**Auditor note**: PCI-DSS scope is clean (Square handles all card data). Square developer terms are followed correctly. However, PIPEDA compliance has gaps: no data retention policy, no data subject access request procedure, and no explicit consent mechanism for PII collected through Square API sync.

---

## 13.1 PII Inventory

### Customer PII (stored in database)

| Table | PII Columns | Source |
|-------|-------------|--------|
| `loyalty_customers` | `given_name`, `family_name`, `display_name`, `phone_number`, `email_address`, `company_name`, `birthday` | Square Customers API (cached locally) |
| `delivery_orders` | `customer_name`, `address`, `address_lat/lng`, `phone`, `notes`, `signature_data`, `pod_image_path` | Square Orders API |
| `delivery_pod` | `photo_path`, `latitude/longitude` | Proof-of-delivery photos (potentially shows property) |
| `cart_activity` | `square_customer_id`, `customer_id_hash`, `phone_last4`, `items_json` | Shopping behavior tracking |
| `loyalty_purchase_events` | `square_customer_id`, `receipt_url` | Purchase history per customer |
| `loyalty_rewards` | `square_customer_id` + full reward/redemption history | Behavioral data |
| `loyalty_audit_logs` | `square_customer_id` | Audit trails with customer references |
| `seniors_group_members` | `square_customer_id`, `birthday`, `age_at_last_check` | Sensitive age-related data |
| `customer_birthday_map` | `customer_id`, `birthday_month`, `birthday_day` | Square Customers |
| `seniors_registry` | `customer_id`, `customer_name`, `registered_phone`, `registered_email` | Customer self-registration |

### User/Employee PII

| Table | PII Columns |
|-------|-------------|
| `users` | `email`, `password_hash`, `name` |
| `auth_audit_log` | `email`, `ip_address`, `user_agent` |
| `password_reset_tokens` | `user_id` (FK to users) |

### Financial/Business Data

| Table | PII Columns |
|-------|-------------|
| `merchants` | `business_name`, `admin_email`, `square_access_token` (encrypted), `square_refresh_token` (encrypted) |
| `subscription_invoices` | `amount_cents`, `square_payment_id` |
| `subscribers` | `email`, `square_customer_id` |

### Sensitive Tokens

| Token | Storage | Status |
|-------|---------|--------|
| `square_access_token` | AES-256-GCM encrypted | PASS |
| `square_refresh_token` | AES-256-GCM encrypted | PASS |
| `google_access_token` | AES-256-GCM encrypted | PASS |
| `google_refresh_token` | AES-256-GCM encrypted | PASS |
| `claude_api_key` | AES-256-GCM encrypted | PASS |
| `gmc_feed_token` | **Plaintext** | LOW — URL auth token for Google Merchant Center; inconsistent with encryption policy |

---

## 13.2 PIPEDA Considerations

**Rating: NEEDS WORK**

### Consent

- **Merchant consent**: ToS includes positive checkbox consent at subscription time (`terms_accepted_at` tracked). Section 6 ("Data Processing") authorizes Square data access.
- **End-customer consent GAP**: The ToS covers merchant consent for their own Square data, but does NOT address consent for **end-customer** data (names, phones, emails, birthdays, purchase histories cached in `loyalty_customers`, `delivery_orders`, `seniors_group_members`). The merchant is the data controller under PIPEDA and should have their own privacy policy, but this platform has no mechanism to ensure that.
- **No separate Privacy Policy document**: The ToS mentions data security but does not describe what data is collected, why, retention periods, or third-party transfers. PIPEDA Principle 4.3 requires meaningful consent with clear description of purposes.

### Data Retention

| Data | Retention | Status |
|------|-----------|--------|
| Webhook events | 14/30 day cleanup (`cleanupOldEvents`) | IMPLEMENTED |
| Delivery POD photos | Configurable `pod_retention_days` (default 180 days) | IMPLEMENTED |
| Cart activity | `purgeOld` function exists | IMPLEMENTED |
| `loyalty_customers` (names, emails, phones, birthdays) | Indefinite | NOT IMPLEMENTED |
| `delivery_orders` (names, addresses) | Indefinite | NOT IMPLEMENTED |
| `seniors_group_members` (birthdays, age) | Indefinite | NOT IMPLEMENTED |
| `loyalty_purchase_events` | Indefinite | NOT IMPLEMENTED |
| `auth_audit_log` (IP addresses) | Indefinite | NOT IMPLEMENTED |
| Log files (emails) | 14-30 day retention (Winston rotation) | IMPLEMENTED |
| Data subject access request (DSAR) | No endpoint or procedure | NOT IMPLEMENTED |

### Cross-Border Data Transfer

- Square API servers are US-based -- customer PII (names, emails, phones, purchase history) crosses Canada/US border
- Google APIs (GMC feed, OAuth) -- data crosses border
- OpenRouteService (EU-based) -- delivery addresses with GPS coordinates sent for geocoding
- PIPEDA allows cross-border transfers but requires the transferring organization remain accountable (Principle 4.1.3)
- **No disclosure of cross-border transfers to subscribers in ToS**
- No documented data processing agreements (DPAs) beyond standard Square/Google terms

### Breach Notification

- Email alerting exists for critical errors (`utils/email-notifier.js`)
- No specific breach detection or notification procedure
- PIPEDA requires notification to Privacy Commissioner and affected individuals "as soon as feasible" for breaches creating "real risk of significant harm"

---

## 13.3 PCI-DSS Scope

**Rating: PASS**

No credit card data is stored anywhere in the codebase or database:

- Zero matches for `card_number`, `cvv`, `pan`, `credit_card`, `card_data` in code or schema. Test files explicitly assert these fields are NOT present (`expect(subscriber).not.toHaveProperty('card_number')`)
- `subscribers` table stores only `card_brand` (e.g., "VISA"), `card_last_four`, and `card_id` (Square's card-on-file token) -- not considered cardholder data under PCI-DSS
- Square handles all payment processing via Web Payments SDK (client-side tokenization)
- Application stores only `square_payment_id` (opaque reference) and `amount_cents`
- **No SAQ required** -- app never touches card data

---

## 13.4 Square Developer Terms

**Rating: PASS**

### Data Storage

- Catalog data synced and stored locally (items, variations, categories, vendors, inventory) -- permitted for performance
- Customer data stored locally (names, emails, phones from orders) -- permitted for order fulfillment
- No bulk customer export or unauthorized marketing use detected

### Webhook Signature Verification

- HMAC-SHA256 verification in `services/webhook-processor.js` using `crypto.timingSafeEqual` (timing-safe comparison)
- Hashes `notificationUrl + rawBody` per Square's spec
- Raw body correctly preserved for verification (`server.js:150-155`)
- Missing `SQUARE_WEBHOOK_SIGNATURE_KEY` causes rejection in production
- Comprehensive test coverage in `__tests__/security/webhook-signature.test.js`

### OAuth Token Handling

- Tokens encrypted at rest (AES-256-GCM)
- Refresh flow implemented
- Token revocation endpoint exists (`routes/square-oauth.js:413`)
- No token sharing between merchants

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 13.1 PII Inventory | INFO | PII across 12+ tables; all financial tokens encrypted except gmc_feed_token |
| 13.2 PIPEDA | NEEDS WORK | No data retention policy, no DSAR procedure, no explicit consent |
| 13.3 PCI-DSS | PASS | Zero card data in scope; Square handles all payment processing |
| 13.4 Square Terms | PASS | Webhook verification, encrypted tokens, proper OAuth flow |

## Recommendations

| Priority | Item | Effort |
|----------|------|--------|
| HIGH | Create PIPEDA-compliant privacy policy (data collected, purposes, retention, third-party transfers, access rights) | 4-6 hours |
| HIGH | Implement data retention for customer PII (`loyalty_customers`, `delivery_orders`, `seniors_group_members`, `auth_audit_log`) | 4-8 hours |
| HIGH | Build DSAR endpoints: data export per merchant, account deletion with cascading PII purge | 4-6 hours |
| MEDIUM | Document breach notification procedure (72-hour Commissioner notification, individual notification, record-keeping) | 2-3 hours |
| MEDIUM | Disclose cross-border data transfers (Square US, Google US, OpenRouteService EU) in ToS/privacy policy | 2 hours |
| MEDIUM | Encrypt `gmc_feed_token` at rest for consistency | 1 hour |
| LOW | Add `stale_after` column to `loyalty_customers` to flag records not refreshed from Square in N days | 2 hours |
