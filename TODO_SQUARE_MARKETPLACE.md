# Square Marketplace Compliance - TODO

This document tracks items that need to be addressed before submitting to the Square App Marketplace.

## Audit Date: 2025-12-14

---

## Critical Items (Must Fix Before Submission)

### 1. User-Friendly Error Messages
**Status:** Not Implemented
**Priority:** HIGH
**Requirement:** Your app presents user-friendly error messages to the end-user.

**Current State:**
- Backend returns technical `error.message` directly to frontend
- No standardized error format or error codes
- Users see raw database/API errors

**Implementation Tasks:**
- [ ] Create error code mapping system (e.g., `ERR_SYNC_FAILED`, `ERR_INVALID_INPUT`)
- [ ] Add user-friendly message translations for each error code
- [ ] Implement error response middleware in `server.js`
- [ ] Add toast/notification system to frontend HTML pages
- [ ] Test all error scenarios return appropriate user messages

**Files to Modify:**
- `server.js` - Add error middleware
- `public/*.html` - Add toast notification UI component
- New file: `utils/error-handler.js` - Error code definitions and mappings

---

### 2. Square Webhook Integration
**Status:** Not Implemented
**Priority:** HIGH
**Requirement:** Your app responds to external applications with expected behavior, such as responding to a refund request from another application or authorization revocation from Square.

**Current State:**
- App uses pull-based sync only (cron jobs)
- No webhook endpoints exist
- No real-time event processing

**Implementation Tasks:**
- [ ] Create webhook endpoint: `POST /api/webhooks/square`
- [ ] Implement HMAC-SHA256 signature verification
- [ ] Handle `refund.created` and `refund.updated` events
- [ ] Handle `catalog.version.updated` events
- [ ] Handle `inventory.count.updated` events
- [ ] Handle `oauth.authorization.revoked` events
- [ ] Add webhook event logging to database
- [ ] Register webhook subscriptions in Square Dashboard
- [ ] Add webhook retry/acknowledgment logic

**Files to Create/Modify:**
- New file: `utils/webhook-handler.js`
- `server.js` - Add webhook routes
- `database/schema.sql` - Add `webhook_events` table

**Square Documentation:**
- https://developer.squareup.com/docs/webhooks/overview
- https://developer.squareup.com/docs/webhooks/signature-validation

---

### 3. OAuth Authorization Revocation Handling
**Status:** Not Implemented
**Priority:** HIGH
**Requirement:** App responds to authorization revocation from Square.

**Current State:**
- No Square OAuth implemented (uses static access token)
- No handling of token revocation events

**Implementation Tasks:**
- [ ] Implement Square OAuth 2.0 flow (if moving away from static tokens)
- [ ] Add endpoint to handle `oauth.authorization.revoked` webhook
- [ ] Clear cached tokens and notify user when revocation occurs
- [ ] Add graceful degradation when auth is revoked mid-session

**Files to Modify:**
- `utils/square-api.js` - Add OAuth token management
- `server.js` - Add OAuth routes
- New file: `utils/oauth-handler.js`

---

### 4. Refund Event Processing
**Status:** Not Implemented
**Priority:** HIGH
**Requirement:** App responds to refund requests from another application.

**Current State:**
- Refunds in Square are not tracked
- Sales velocity data doesn't account for refunds

**Implementation Tasks:**
- [ ] Add `refunds` table to database schema
- [ ] Process `refund.created` webhook events
- [ ] Update sales velocity calculations to subtract refunded quantities
- [ ] Add refund display to sales reports
- [ ] Consider inventory adjustment on refunds (if applicable)

**Files to Modify:**
- `database/schema.sql` - Add refunds table
- `utils/square-api.js` - Add refund sync function
- `server.js` - Add refund API endpoints

---

## Recommended Improvements (Nice to Have)

### 5. Circuit Breaker Pattern
**Status:** Not Implemented
**Priority:** MEDIUM

**Current State:**
- Exponential backoff exists but no circuit breaker
- Repeated failures don't trigger service degradation

**Implementation Tasks:**
- [ ] Implement circuit breaker for Square API calls
- [ ] Add failure threshold configuration
- [ ] Add health check endpoint that reflects circuit state
- [ ] Notify admin when circuit opens

---

### 6. Request ID Tracking
**Status:** Not Implemented
**Priority:** LOW

**Current State:**
- No correlation IDs for debugging request chains

**Implementation Tasks:**
- [ ] Generate unique request ID for each API call
- [ ] Pass request ID through all log entries
- [ ] Return request ID in error responses
- [ ] Add request ID to email notifications

---

### 7. Database Connection Recovery
**Status:** Partial
**Priority:** MEDIUM

**Current State:**
- Pool errors cause immediate server crash (`process.exit(-1)`)

**Implementation Tasks:**
- [ ] Implement graceful connection retry logic
- [ ] Add connection health check endpoint
- [ ] Queue requests during brief connection failures
- [ ] Alert admin on persistent connection issues

**File to Modify:**
- `utils/database.js` - Replace exit with recovery logic

---

## App Listing Requirements

### 8. Support Contact Information
**Status:** Needs Configuration
**Priority:** HIGH
**Requirement:** Your App Marketplace listing and app provide a support email address, phone number, or other channel.

**Implementation Tasks:**
- [ ] Configure support email in production
- [ ] Add support link/email to app footer (public/index.html)
- [ ] Create support documentation page
- [ ] Set up support email monitoring

---

### 9. App Requirements Documentation
**Status:** Partial
**Priority:** MEDIUM
**Requirement:** Your app's technical requirements are clearly specified in the App Requirements section.

**Current Documentation Covers:**
- [x] Node.js version (18+)
- [x] PostgreSQL version (14+)
- [x] Square API access token requirement

**Needs Addition:**
- [ ] Minimum server RAM requirements
- [ ] Disk space requirements
- [ ] Network requirements (outbound HTTPS)
- [ ] Required Square permissions/scopes
- [ ] Browser compatibility for UI

---

## Compliance Checklist Summary

| Requirement | Status | Priority |
|-------------|--------|----------|
| User-friendly error messages | ❌ TODO | HIGH |
| Internal error logging | ✅ Done | - |
| HTTP error handling (4XX/5XX) | ✅ Done | - |
| Exponential backoff for rate limits | ✅ Done | - |
| Setup/usage documentation | ✅ Done | - |
| Webhook event handling | ❌ TODO | HIGH |
| Refund request handling | ❌ TODO | HIGH |
| OAuth revocation handling | ❌ TODO | HIGH |
| Support contact in app | ⚠️ Configure | HIGH |
| Technical requirements docs | ⚠️ Partial | MEDIUM |
| Cursor-based pagination | ✅ Done | - |
| Circuit breaker | ❌ Optional | MEDIUM |
| Request ID tracking | ❌ Optional | LOW |

---

## Future API Integration Requirements

The following sections document requirements for additional Square APIs that may be integrated in the future. These are **NOT currently implemented** but are documented here for future reference.

---

### FUTURE: Webhooks API Requirements
**Status:** Not Applicable (until webhooks implemented)
**When Needed:** When implementing real-time event handling

**Requirements:**
- [ ] App responds to trigger events with expected behavior
- [ ] Errors are surfaced appropriately within internal logs to the buyer/seller
- [ ] Errors are surfaced to the event trigger when necessary
- [ ] Webhook signature validation implemented (HMAC-SHA256)
- [ ] Proper HTTP response codes returned (200 for success, 4XX/5XX for errors)
- [ ] Idempotency handling for duplicate webhook deliveries

**Documentation:** https://developer.squareup.com/docs/webhooks/overview

---

### FUTURE: Terminal API Requirements
**Status:** Not Applicable (no Terminal integration planned)
**When Needed:** If integrating with Square Terminal hardware

**Conditional Requirements:**
If subscribing to `device.code.paired` webhook:
- [ ] Handle device pairing events

If processing payments in US/Canada/Japan:
- [ ] Comply with regional payment requirements

**Core Requirements (if implemented):**
- [ ] Request DEVICE_CREDENTIAL_MANAGEMENT permission in OAuth
- [ ] Prompt seller to select location for Square Terminal registration
- [ ] Alert user when switching Square locations to re-register terminals
- [ ] Generate valid device codes
- [ ] Provide UI/UX for seller to pair device with generated code
- [ ] Notify seller of device code expiration timeline
- [ ] Respond to checkout state changes
- [ ] Set country/currency code to Square account's currency
- [ ] Provide partner name and unique transaction ID in note parameter

**Documentation:** https://developer.squareup.com/docs/terminal-api/overview

---

### FUTURE: Team API Requirements
**Status:** Not Applicable (no Team management planned)
**When Needed:** If adding employee/team member management features

**Sync Direction Options:**
- Bi-directional sync
- One-way: Partner Platform → Square
- One-way: Square → Partner Platform

**Requirements (if implemented):**
- [ ] Determine sync direction and document behavior
- [ ] Handle team member create/update/delete operations
- [ ] Sync wage information (if applicable)
- [ ] Handle location assignments
- [ ] Maintain data consistency between systems

**Documentation:** https://developer.squareup.com/docs/team-api/overview

---

### FUTURE: Subscriptions API Requirements
**Status:** Not Applicable (no subscription features planned)
**When Needed:** If adding recurring billing/subscription features

**Conditional Requirements:**
If using invoice webhooks for subscription payments:
- [ ] Track successful subscription payments via webhooks
- [ ] Track failed subscription payments via webhooks

**Core Requirements (if implemented):**
- [ ] Disable/hide subscriptions tied to disabled SubscriptionPlanVariation catalog objects
- [ ] Only associate subscriptions with customer profiles that have valid email
- [ ] Display current subscription state (PENDING, ACTIVE, CANCELED) to buyers
- [ ] Do NOT allow adding, removing, or reordering subscription phases
- [ ] Ensure phases in SubscriptionPlanVariation match ordinals/phases in SubscriptionPlan
- [ ] Provide customers ability to cancel subscription
- [ ] Provide customers ability to continue a pending canceled subscription
- [ ] Allow customers to add/remove card on file for subscription

**Documentation:** https://developer.squareup.com/docs/subscriptions-api/overview

---

## Resources

- [Square App Marketplace Guidelines](https://developer.squareup.com/docs/app-marketplace/requirements)
- [Square Webhooks Documentation](https://developer.squareup.com/docs/webhooks/overview)
- [Square OAuth Documentation](https://developer.squareup.com/docs/oauth-api/overview)
- [Square API Error Handling](https://developer.squareup.com/docs/build-basics/handling-errors)

---

*Last Updated: 2025-12-14*
