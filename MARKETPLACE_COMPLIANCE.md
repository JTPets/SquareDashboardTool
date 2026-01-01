# Square App Marketplace Compliance Document

**App Name:** SqTools.ca - Square Dashboard Addon Tool
**Developer:** JTPets
**Last Updated:** January 1, 2026
**Status:** Pre-Submission

---

## General Requirements Checklist

### Error Handling

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| User-friendly error messages | ✅ Complete | `public/js/error-helper.js` - Maps technical errors to friendly messages with context-specific messaging for sync, inventory, catalog, orders, vendors, and settings |
| Errors surfaced in internal logs | ✅ Complete | `utils/logger.js` - Winston logger with daily rotation, separate error logs retained 30 days |
| HTTP 4XX/5XX error handling | ✅ Complete | 187 try-catch blocks in server.js, global error handler, standardized JSON error responses |

### Rate Limiting & API Best Practices

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Exponential backoff for rate limits | ✅ Complete | `utils/square-api.js:100` - `delay = 1000 * Math.pow(2, attempt)` with max 3 retries |
| Respects Retry-After header | ✅ Complete | `utils/square-api.js:56-61` - Parses and honors `retry-after` header on 429 responses |
| Cursor pagination | ✅ Complete | 11 functions implement cursor-based pagination for catalog, inventory, orders, etc. |

### Documentation & Support

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Clear setup/usage documentation | ✅ Complete | 40KB README.md with installation, API docs, workflows, troubleshooting |
| Support email displayed | ✅ Complete | `JTPets@JTPets.ca` on support.html with 1-2 business day response time |
| Support language indicated | ✅ Complete | English only - indicated on support page |

### External Application Response

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| OAuth authorization revocation | ✅ Complete | `server.js:8132-8159` - Handles `oauth.authorization.revoked` webhook, logs warning, flags for re-auth |
| Refund handling | ✅ Complete | Subscription refunds via `/api/subscriptions/refund` endpoint |
| Webhook signature verification | ✅ Complete | HMAC-SHA256 validation of Square webhook signatures |

---

## App Marketplace Listing Content

### App Description (Draft)

**Title:** SqTools.ca - Inventory Management & Reorder Automation

**Short Description:**
Powerful inventory management, smart reorder suggestions, and purchase order automation built specifically for Square merchants.

**Full Description:**
SqTools.ca enhances your Square experience with advanced inventory management tools:

- **Real-time Inventory Sync** - Automatic synchronization with your Square catalog
- **Sales Velocity Tracking** - Understand how fast products sell to optimize stock levels
- **Smart Reorder Suggestions** - AI-powered recommendations based on sales patterns and lead times
- **Purchase Order Management** - Create, track, and manage vendor purchase orders
- **Vendor Management** - Organize suppliers and track costs
- **Automated Alerts** - Get notified when stock runs low

### Technical Requirements

| Requirement | Details |
|-------------|---------|
| Square Account | Required - Free or paid Square account |
| Hardware | None - fully web-based, hosted solution |
| Operating System | Any modern web browser (Chrome, Firefox, Safari, Edge) |
| Square Subscriptions | None required - works with free Square accounts |
| Additional Software | None - SaaS solution, no installation required |

### Features Section (for listing)

**Only publicly available Square features are used:**

| Feature | Square API | Status |
|---------|------------|--------|
| Catalog Management | Catalog API | ✅ Public |
| Inventory Tracking | Inventory API | ✅ Public |
| Order History | Orders API | ✅ Public |
| OAuth Authentication | OAuth API | ✅ Public |
| Webhooks | Webhooks API | ✅ Public |
| Subscriptions/Billing | Subscriptions API | ✅ Public |
| Vendor Management | Vendors API | ⚠️ Alpha* |

*\*Vendors API is currently in Alpha. This feature mirrors functionality available in the Square Dashboard. Will update integration when API reaches General Availability.*

### Pricing

| Plan | Price | Features |
|------|-------|----------|
| Free Trial | $0 for 14 days | Full access to all features |
| Monthly | $XX/month | Full access, priority support |

---

## Multi-Country Availability

**Countries:** Canada (primary), United States

**Language Support:**
- Application Interface: English
- Customer Support: English only
- Documentation: English

---

## Contact Information

| Type | Details |
|------|---------|
| Support Email | JTPets@JTPets.ca |
| Response Time | 1-2 business days |
| Support Hours | Monday-Friday, 9am-5pm EST |
| Website | https://SqTools.ca |

---

## Compliance Verification

### Security

- [x] OAuth 2.0 PKCE flow implementation
- [x] Secure token storage (encrypted in database)
- [x] HTTPS enforced in production
- [x] Rate limiting on all endpoints
- [x] Login attempt limiting (5 per 15 minutes)
- [x] Webhook signature verification
- [x] SQL injection prevention (parameterized queries)
- [x] XSS prevention (input sanitization)

### Data Handling

- [x] Merchant data isolation (multi-tenant architecture)
- [x] No sensitive data logging
- [x] Automatic log rotation and cleanup
- [x] Database connection pooling

### API Best Practices

- [x] Exponential backoff on rate limits
- [x] Cursor-based pagination for large datasets
- [x] Idempotency key support
- [x] Graceful error handling
- [x] Webhook event deduplication

---

## Pre-Submission Checklist

- [ ] Create Square Developer account (if not done)
- [ ] Submit app for review
- [ ] Prepare demo video/screenshots
- [ ] Finalize pricing structure
- [ ] Set up production webhook endpoints
- [ ] Configure production OAuth redirect URIs
- [ ] Test complete user flow in sandbox
- [ ] Review and accept Square Developer Terms

---

## Notes for Reviewers

1. **Vendors API Alpha Access**: We have alpha access to the Vendors API. This functionality mirrors what's available in the Square Dashboard. We will transition to GA API when available.

2. **Hosted Solution**: This is a fully hosted SaaS solution. Merchants do not need to install anything - they simply connect their Square account via OAuth.

3. **Multi-Tenant Architecture**: The application supports multiple merchants with complete data isolation using merchant_id filtering on all database queries.

---

*Document Version: 1.0*
*Prepared for Square App Marketplace Submission*
