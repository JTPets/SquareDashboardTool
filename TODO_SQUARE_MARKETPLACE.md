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
**Status:** Implemented
**Priority:** HIGH
**Requirement:** Your App Marketplace listing and app provide a support email address, phone number, or other channel.

**Implementation Tasks:**
- [x] Configure support email in production (JTPets@JTPets.ca)
- [x] Add support link/email to app footer (public/index.html)
- [x] Create support documentation page (public/support.html)
- [x] Set up support email monitoring (mobile push notifications)

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
| Support contact in app | ✅ Done | - |
| Technical requirements docs | ⚠️ Partial | MEDIUM |
| Cursor-based pagination | ✅ Done | - |
| Location selector UI | ✅ Done | - |
| Location Custom Attributes | N/A (not used) | - |
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

### FUTURE: Snippets API Requirements
**Status:** Not Applicable (no Square Online integration planned)
**When Needed:** If adding code snippets to Square Online sites

**Conditional Requirements:**
If snippet requires copy/paste code:
- [ ] Provide clear instructions for code installation

**Core Requirements (if implemented):**
- [ ] Square Online websites are listed and selectable
- [ ] Snippets are pushed only to selected Square Online sites
- [ ] Display name, domain name, and online status of each site in selection
- [ ] App can create a snippet
- [ ] App can edit or update a snippet
- [ ] App can remove or delete a snippet
- [ ] Provide confirmation that snippet was successfully added
- [ ] Snippet assets are sufficient quality for most common devices
- [ ] Snippets work well on both mobile and desktop
- [ ] Snippets don't use JavaScript alert/confirmation boxes
- [ ] Snippets don't display annoying or distracting behavior
- [ ] Snippets don't ask for passwords of any kind
- [ ] Snippet use is adequately disclosed to the seller
- [ ] Snippets don't expose buyers to user-unfriendly text (code, debug, technical errors)
- [ ] Error messages displayed are in user-friendly format
- [ ] Snippets don't overly obscure major elements on Square Online sites
- [ ] Snippets don't overly obscure major elements on mobile sites (iOS/Android)

**Documentation:** https://developer.squareup.com/docs/snippets-api/overview

---

### FUTURE: Payouts API Requirements
**Status:** Not Applicable (no payout tracking planned)
**When Needed:** If adding payout/settlement tracking features

**Core Requirements (if implemented):**
- [ ] Successfully indicate all three payout states: SENT, FAILED, and PAID
- [ ] Handle instant deposits with associated payout_fee
- [ ] Handle payouts with net positive value
- [ ] Handle payouts with net negative value
- [ ] Handle payouts with net zero value
- [ ] Pull in all payout entry types

**Documentation:** https://developer.squareup.com/docs/payouts-api/overview

---

### FUTURE: Payments API Requirements
**Status:** Not Applicable (read-only order data currently)
**When Needed:** If creating or updating payments in Square

**Conditional Requirements:**
If app creates/updates payments:
- [ ] Implement full payment creation flow
- [ ] Handle payment authorization, capture, and void
- [ ] Support refunds through Payments API

If app only reads payment data:
- [ ] Transactions in app exactly reflect transactions in Square

**Current State:** App reads order/sales data for velocity calculations (read-only)

**Documentation:** https://developer.squareup.com/docs/payments-api/overview

---

### FUTURE: Orders API Requirements
**Status:** Partial (read-only for sales velocity)
**When Needed:** If creating orders, managing fulfillments, or using custom attributes

**Conditional Requirements:**
If app creates orders in Square:
- [ ] Implement order creation flow
- [ ] Handle order line items, taxes, discounts
- [ ] Support order modifications

If app manages order fulfillments:
- [ ] Track fulfillment states (PROPOSED, RESERVED, PREPARED, COMPLETED, CANCELED)
- [ ] Update fulfillment status appropriately
- [ ] Handle pickup and delivery fulfillments

If app completes/cancels orders:
- [ ] Implement order completion flow
- [ ] Handle order cancellation with reason

If app shows order sales data:
- [ ] Display order items accurately
- [ ] Display prices, taxes correctly
- [ ] Show fulfillment state appropriately

If app uses Order Custom Attributes API:
- [ ] Create custom attribute definitions
- [ ] Read/write custom attribute values
- [ ] Handle attribute visibility settings

**Current State:** App reads completed orders for sales velocity calculations only

**Documentation:** https://developer.squareup.com/docs/orders-api/overview

---

### FUTURE: Labor API Requirements
**Status:** Not Applicable (no labor/shift management planned)
**When Needed:** If adding employee shift tracking features

**Conditional Requirements:**
If app creates/updates labor shifts:
- [ ] Implement shift creation flow
- [ ] Handle shift modifications
- [ ] Validate shift times and breaks

If app reports shift data:
- [ ] Display shift data accurately
- [ ] Handle multiple team members
- [ ] Support location filtering

**Documentation:** https://developer.squareup.com/docs/labor-api/overview

---

### FUTURE: Gift Cards API Requirements
**Status:** Not Applicable (no gift card features planned)
**When Needed:** If adding gift card management features

**Conditional Requirements:**
If syncing gift card activities from Square:
- [ ] Track gift card transactions
- [ ] Display activity history accurately

If allowing gift card purchases on platform:
- [ ] Implement gift card creation flow
- [ ] Handle gift card activation
- [ ] Support gift card balance inquiries

If using custom GANs (Gift Card Account Numbers):
- [ ] Implement custom GAN generation
- [ ] Validate GAN format requirements

**Documentation:** https://developer.squareup.com/docs/gift-cards-api/overview

---

### FUTURE: Invoices API Requirements
**Status:** Partial (reads invoices for committed inventory)
**When Needed:** If creating invoices or handling invoice payments

**Current State:** App reads open invoices to calculate committed inventory

**Conditional Requirements:**
If using Square catalog items:
- [ ] Reference valid catalog item IDs
- [ ] Handle catalog item updates/deletions

If using ad hoc line items:
- [ ] Properly format ad hoc item data
- [ ] Include all required fields

If subscribing to invoice webhooks:
- [ ] Track successful invoice payments
- [ ] Track failed invoice payments

**Core Requirements (if creating invoices):**
- [ ] Create customer profiles with given_name, family_name, email_address
- [ ] Cancel invoices for deleted customers (unless valid reason to keep)
- [ ] Assign customer ID to orders (creator and recipient can differ)
- [ ] Gracefully handle sellers not on Invoices Plus
- [ ] Provide all taxes, discounts, surcharges via CreateOrder/UpdateOrder

**Documentation:** https://developer.squareup.com/docs/invoices-api/overview

---

### FUTURE: Customers API Requirements
**Status:** Not Applicable (no customer management planned)
**When Needed:** If adding customer management features

**Conditional Requirements:**
If using Card on File:
- [ ] Securely store card references
- [ ] Handle card expiration/updates
- [ ] Support card removal

If creating/updating customers in Square:
- [ ] Validate customer data before sync
- [ ] Handle duplicate detection
- [ ] Support customer merging

If importing customers from Square:
- [ ] Paginate through all customers
- [ ] Handle customer updates
- [ ] Respect data privacy requirements

If using Customer Custom Attributes:
- [ ] Create custom attribute definitions
- [ ] Read/write attribute values
- [ ] Handle visibility settings

If using Customer Groups:
- [ ] Create/manage groups
- [ ] Assign customers to groups
- [ ] Handle group membership changes

If using Customer Segments:
- [ ] Display segment data
- [ ] Handle segment updates
- [ ] Support filtering by segment

**Documentation:** https://developer.squareup.com/docs/customers-api/overview

---

### CURRENT: Catalog and Inventory API Requirements
**Status:** Implemented (one-way sync: Square → App)
**Priority:** Review for marketplace compliance

**Current Implementation:**
- Sync direction: One-way (Square → Partner Platform)
- Uses Catalog Custom Attributes API: YES (case_pack_quantity, brand)
- Uses Inventory API: YES (read-only inventory counts)

**Sync Direction Requirements (Square → Partner):**
- [x] App syncs catalog data from Square
- [x] Handle catalog updates gracefully
- [x] Support pagination for large catalogs
- [ ] Handle catalog item deletions (soft delete implemented)

**Custom Attributes Requirements:**
- [x] Create custom attribute definitions (case_pack_quantity, brand)
- [x] Read custom attribute values
- [x] Write custom attribute values back to Square
- [ ] Handle attribute definition changes gracefully

**Inventory API Requirements:**
- [x] Sync inventory counts from Square
- [x] Handle multi-location inventory
- [x] Support inventory alerts/thresholds
- [ ] Handle inventory adjustments (not implemented - read-only)

**Documentation:** https://developer.squareup.com/docs/catalog-api/overview

---

### FUTURE: Bookings API Requirements
**Status:** Not Applicable (no appointment booking planned)
**When Needed:** If adding appointment/booking features

**Conditional Requirements:**
If using Booking Custom Attributes:
- [ ] Create custom attribute definitions
- [ ] Read/write attribute values

**Core Requirements (if implemented):**
- [ ] Filter by available services
- [ ] Filter by available team members
- [ ] Filter by Square location (multi-location)
- [ ] Handle <24 hour search range gracefully (or notify of limitation)
- [ ] Handle >31 day search range gracefully (or notify of limitation)
- [ ] Surface booking fees accurately
- [ ] Create and save bookings on platform
- [ ] Allow bookings to be edited by time
- [ ] Allow bookings to be canceled by customers
- [ ] Allow bookings to be canceled by sellers

**Documentation:** https://developer.squareup.com/docs/bookings-api/overview

---

### CURRENT: Locations API Requirements
**Status:** Implemented (location selector in UI)
**Priority:** Review for marketplace compliance

**Current Implementation:**
- Location connection method: Seller selects locations from a field in the user interface
- Uses Location Custom Attributes API: NO
- Multi-location support: YES (inventory, reorder suggestions, PO generation)

**Location Selection Requirements (UI Selector):**
- [x] App provides UI for seller to select their desired Square locations
- [x] Location selector populated from Square Locations API
- [x] Active/inactive location status respected
- [x] Location filtering available on inventory views
- [x] Location filtering available on reorder suggestions
- [x] Location filtering available on purchase order generation
- [ ] Store selected location preferences per user/session
- [ ] Handle location addition/removal gracefully (new locations from Square)
- [ ] Validate location access permissions before operations

**Core Location Requirements:**
- [x] Retrieve merchant's locations via Locations API
- [x] Store location data locally (locations table)
- [x] Support operations across multiple locations
- [x] Display location names in UI dropdowns and reports
- [ ] Handle location timezone differences for reporting
- [ ] Refresh location list on demand or periodically

**Conditional Requirements:**
If app allows location-specific settings:
- [ ] Store settings per location
- [ ] Provide UI for per-location configuration

If app uses Location Custom Attributes API:
- [ ] Create custom attribute definitions for locations
- [ ] Read custom attribute values from locations
- [ ] Write custom attribute values to locations
- [ ] Handle attribute definition changes gracefully

**Documentation:** https://developer.squareup.com/docs/locations-api/overview

---

## Resources

- [Square App Marketplace Guidelines](https://developer.squareup.com/docs/app-marketplace/requirements)
- [Square Webhooks Documentation](https://developer.squareup.com/docs/webhooks/overview)
- [Square OAuth Documentation](https://developer.squareup.com/docs/oauth-api/overview)
- [Square API Error Handling](https://developer.squareup.com/docs/build-basics/handling-errors)

---

*Last Updated: 2025-12-14*
