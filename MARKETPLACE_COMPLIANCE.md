# Square App Marketplace Compliance

SqTools is built to meet all requirements for the Square App Marketplace.

---

## OAuth Implementation

| Requirement | Status |
|-------------|--------|
| OAuth 2.0 authorization code flow | ✅ |
| State parameter CSRF protection | ✅ |
| Minimum required permissions | ✅ |
| Token encryption at rest (AES-256-GCM) | ✅ |
| Automatic token refresh | ✅ |
| Revocation handling via webhook | ✅ |
| User-friendly OAuth deny handling | ✅ |

### Requested Permissions
- `MERCHANT_PROFILE_READ` — Read merchant profile
- `ITEMS_READ` — Read catalog items
- `ITEMS_WRITE` — Update custom attributes
- `INVENTORY_READ` — Read inventory counts
- `INVENTORY_WRITE` — Update inventory
- `ORDERS_READ` — Read order history

---

## API Best Practices

| Requirement | Status |
|-------------|--------|
| Exponential backoff on rate limits | ✅ |
| Retry-After header respected | ✅ |
| Cursor-based pagination | ✅ |
| Idempotency key support | ✅ |
| Graceful error handling | ✅ |

---

## Webhook Handling

| Requirement | Status |
|-------------|--------|
| HMAC-SHA256 signature verification | ✅ |
| Event deduplication | ✅ |
| OAuth revocation handling | ✅ |
| User-friendly error messages | ✅ |

### Handled Events
- `catalog.version.updated`
- `inventory.count.updated`
- `order.created`, `order.updated`, `order.fulfillment.updated`
- `oauth.authorization.revoked`
- `vendor.created`, `vendor.updated`
- `location.created`, `location.updated`
- `payment.created`, `payment.updated`
- `refund.created`, `refund.updated`
- `subscription.*`, `invoice.*`
- `customer.updated`, `customer.deleted`
- `loyalty.event.created`

---

## Custom Attributes

SqTools uses the following app-scoped custom attributes:

| Attribute | Type | Purpose |
|-----------|------|---------|
| `case_pack_quantity` | NUMBER | Case pack size for reorder calculations |
| `brand` | STRING | Brand assignment for loyalty and feeds |
| `expiration_date` | STRING | Product expiration tracking |
| `does_not_expire` | BOOLEAN | Non-perishable flag |
| `expiry_reviewed_at` | STRING | Expiry review timestamp |

No sensitive or PCI data is stored in custom attributes.

---

## Multi-Location Support

- All locations automatically synced from Square
- Per-location inventory tracking
- Per-location reorder settings
- Location filtering on all relevant views

---

## Data Handling

| Requirement | Status |
|-------------|--------|
| Multi-tenant data isolation | ✅ |
| No sensitive data logging | ✅ |
| Encrypted token storage | ✅ |
| Automatic session cleanup | ✅ |

---

## Technical Requirements

| Requirement | Details |
|-------------|---------|
| Square Account | Any free or paid Square account |
| Hardware | None — fully hosted SaaS |
| Operating System | Any modern web browser |
| Additional Software | None required |

---

## Availability

**Countries:** Canada, United States
**Languages:** English
**Support:** support@sqtools.ca (1-2 business day response)

---

*Last Updated: January 2026*
