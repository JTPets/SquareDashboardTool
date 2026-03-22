# Section 13: COMPLIANCE

**Rating: NEEDS WORK**

**Auditor note**: PCI-DSS scope is clean (Square handles all card data). Square developer terms are followed correctly. However, PIPEDA compliance has gaps: no data retention policy, no data subject access request procedure, and no explicit consent mechanism for PII collected through Square API sync.

---

## 13.1 PII Inventory

### Customer PII (stored in database)

| Table | PII Columns | Source |
|-------|-------------|--------|
| `delivery_orders` | `customer_name`, `address`, `address_lat/lng`, `phone`, `notes`, `signature_data`, `pod_image_path` | Square Orders API |
| `loyalty_purchase_events` | `customer_name`, `customer_email`, `customer_phone` | Square Loyalty events |
| `loyalty_rewards` | `customer_name`, `customer_email`, `customer_phone` | Square Loyalty |
| `loyalty_audit_logs` | `customer_name` | Internal audit trail |
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

- No explicit consent mechanism for customer data collection. Customer data flows from Square API (where Square obtains consent) into the local database.
- Delivery module stores customer addresses and phone numbers from Square orders -- no separate consent obtained.
- Seniors discount registration collects phone/email via user action (implicit consent) but no documented privacy notice.

### Data Retention

| Gap | Status |
|-----|--------|
| Automated PII cleanup/anonymization | NOT IMPLEMENTED |
| `delivery_orders` (names, addresses) | Retained indefinitely |
| `loyalty_purchase_events` (emails, phones) | Retained indefinitely |
| `auth_audit_log` (IP addresses) | Retained indefinitely |
| Log files (emails) | 14-30 day retention (via Winston rotation) |
| Data subject access request (DSAR) | No endpoint or procedure |

### Cross-Border Data Transfer

- Square API servers are US-based -- customer data crosses Canada/US border
- Google APIs (GMC feed) -- data crosses border
- No documented data processing agreements (DPAs) beyond standard Square/Google terms

### Breach Notification

- Email alerting exists for critical errors (`utils/email-notifier.js`)
- No specific breach detection or notification procedure
- PIPEDA requires notification to Privacy Commissioner and affected individuals "as soon as feasible" for breaches creating "real risk of significant harm"

---

## 13.3 PCI-DSS Scope

**Rating: PASS**

No credit card data is stored anywhere in the codebase or database:

- Zero matches for `card_number`, `cvv`, `pan`, `credit_card`, `card_data` in code or schema
- Square handles all payment processing via Web Payments SDK
- Application stores only `square_payment_id` (opaque reference) and `amount_cents`
- Payment config endpoint exposes only the Square Application ID (public key)
- **No SAQ required** -- app never touches card data

---

## 13.4 Square Developer Terms

**Rating: PASS**

### Data Storage

- Catalog data synced and stored locally (items, variations, categories, vendors, inventory) -- permitted for performance
- Customer data stored locally (names, emails, phones from orders) -- permitted for order fulfillment
- No bulk customer export or unauthorized marketing use detected

### Webhook Signature Verification

- HMAC-SHA256 verification implemented in `routes/webhooks.js`
- Square notification URL and signature header validated

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
| HIGH | Create data retention policy and implement automated PII cleanup | 4-8 hours |
| HIGH | Implement DSAR endpoint or documented manual procedure | 4-6 hours |
| MEDIUM | Add privacy notice to seniors registration flow | 1-2 hours |
| MEDIUM | Encrypt `gmc_feed_token` at rest for consistency | 1 hour |
| MEDIUM | Document cross-border data transfer rationale | 2 hours |
| LOW | Create breach notification procedure document | 2-3 hours |
