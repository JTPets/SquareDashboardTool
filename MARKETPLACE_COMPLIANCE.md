# Square App Marketplace Compliance

SqTools is built to meet all requirements for the Square App Marketplace.

---

## General Requirements

### Error Handling & User Experience

| Requirement | Status |
|-------------|--------|
| App presents user-friendly error messages to end-users | ✅ |
| Errors are surfaced appropriately within internal logs to buyer/merchant | ✅ |
| App handles all HTTP error codes (4XX and 5XX) gracefully | ✅ |
| App uses exponential backoff to manage rate-limit errors | ✅ |
| App can paginate through API results using the `cursor` field | ✅ |

### Documentation & Support

| Requirement | Status |
|-------------|--------|
| Clear documentation for setup and usage | ✅ |
| App responds to external applications with expected behavior (refunds, revocations) | ✅ |
| Sellers directed to customer support for assistance | ✅ |
| App listing accurately reflects technical features and integration scope | ✅ |
| Support email, phone, or other channel provided | ✅ |
| Features section mentions only publicly available Square features | ✅ |
| Technical requirements clearly specified in App Requirements section | ✅ |
| Phone/email support language availability clearly indicated per country | ✅ |

---

## OAuth Implementation

### General OAuth Requirements

| Requirement | Status |
|-------------|--------|
| App name is seller-friendly (no Prod, V1, test references) | ✅ |
| OAuth flow has been moved into Production | ✅ |
| Users must be logged in before initiating OAuth flow | ✅ |
| State parameter used for CSRF validation (unique, unguessable value) | ✅ |
| App requests minimum amount of OAuth permissions | ✅ |
| Selecting Deny shows user-friendly message | ✅ |
| App can successfully complete OAuth flow | ✅ |
| After successful OAuth, user redirected with success message | ✅ |
| App ensures tokens are consistently valid (introspection or read-only endpoint) | ✅ |
| App shows current integration state (connected, disconnected, error) | ✅ |
| Logic to refresh OAuth tokens asynchronously every 7-14 days | ✅ |
| App responds gracefully when access tokens are revoked | ✅ |
| Square access tokens are AES-encrypted in database | ✅ |
| AES encryption key not stored in source control; separate keys for staging/prod | ✅ |
| Square OAuth secret not stored in source control | ✅ |
| Only authorized personnel can manage seller's OAuth access | ✅ |
| App successfully revokes OAuth tokens | ✅ |

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

### Requirements

| Requirement | Status |
|-------------|--------|
| No sensitive location/PCI data stored in custom attributes | ✅ |
| Custom attribute name parameter is unique per seller | ✅ |
| `app_visibility` and `seller_visibility` appropriately set | ✅ |
| Only adds custom attributes to supported item types (ITEM, ITEM_VARIATION, MODIFIER) | ✅ |
| Does not create more than 10 seller-visible and 10 non-seller-visible attributes | ✅ |

### SqTools Custom Attributes

| Attribute | Type | Purpose |
|-----------|------|---------|
| `case_pack_quantity` | NUMBER | Case pack size for reorder calculations |
| `brand` | STRING | Brand assignment for loyalty and feeds |
| `expiration_date` | STRING | Product expiration tracking |
| `does_not_expire` | BOOLEAN | Non-perishable flag |
| `expiry_reviewed_at` | STRING | Expiry review timestamp |

---

## App Subscriptions (If Applicable)

| Requirement | Status |
|-------------|--------|
| At least one plan available | N/A |
| Plan names and benefits complete and error-free | N/A |
| Plan price, cadence, and trials correctly configured | N/A |
| Sign Up link directs to sign up/sign in page | N/A |
| New accounts redirected to Square subscription selection page | N/A |
| Existing accounts without active subscription redirected appropriately | N/A |
| Completing subscription flow redirects with correct plan applied | N/A |
| OAuth connection active and visible after subscribing | N/A |
| Current subscription status and name shown to seller | N/A |
| Dedicated links to manage subscription visible to seller | N/A |

---

## Location Requirements

| Requirement | Status |
|-------------|--------|
| Location names are descriptive and representative | ✅ |
| Location addresses are accurate | ✅ |

---

## Multi-Location Support

- All locations automatically synced from Square
- Per-location inventory tracking
- Per-location reorder settings
- Location filtering on all relevant views

---

## Bookings API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Can filter by available services | N/A |
| Can filter by available team members | N/A |
| Can filter by Square location for multi-location integrations | N/A |
| Time range < 24 hours fails gracefully or notifies customer | N/A |
| Time range > 31 days fails gracefully or notifies customer | N/A |
| Booking fees accurately surfaced | N/A |
| Bookings created and saved on partner platform | N/A |
| Bookings editable by time | N/A |
| Bookings cancelable by customers | N/A |
| Bookings cancelable by sellers | N/A |

---

## Catalog API

### Syncing Items to Square

| Requirement | Status |
|-------------|--------|
| Successfully sync item with one variation | ✅ |
| Successfully sync item with item image | ✅ |
| Successfully sync item with multiple variations | ✅ |
| Successfully sync item with multiple item images | ✅ |
| Items associated with Square category | ✅ |
| Can sync taxes to Square | ✅ |
| Can sync discounts to Square | ✅ |
| Can sync modifier lists to Square | ✅ |

### Syncing Items from Square

| Requirement | Status |
|-------------|--------|
| Successfully sync item with one variation from Square | ✅ |
| Successfully sync item with multiple variations from Square | ✅ |
| Successfully sync item with item image from Square | ✅ |
| Can sync item with location price override | ✅ |
| Can sync category with items from Square | ✅ |
| Item availability by location matches Square catalog | ✅ |
| Minimum/maximum selections respected for modifier lists | ✅ |

---

## Inventory API

| Requirement | Status |
|-------------|--------|
| When item sold in Square, app syncs stock update | ✅ |
| When stock manually updated in Square, app syncs update | ✅ |
| When item sold on platform, app syncs stock update to Square | ✅ |
| When stock manually updated on platform, app syncs to Square | ✅ |

---

## Customers API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Correct `customer_id` supplied to payment-related API calls | N/A |
| `CreateCustomer` uses unique key and doesn't create duplicates | N/A |
| Updating customer in app updates customer in Square | N/A |
| Upon initial sync, customer data imported accurately | N/A |
| Updating customer in Square updates related customer in app | N/A |
| App periodically checks for and updates customer info from Square | N/A |
| Custom attribute name parameter is unique per seller | N/A |
| No sensitive/PCI data stored in customer custom attributes | N/A |
| Does not create more than 100 customer-related custom attribute definitions | N/A |
| Updates to customer groups in Square reflected in app | N/A |
| Removing customer from group in app removes from Square | N/A |
| Adding customer to group in app adds to Square | N/A |
| Updating customer group in app updates in Square | N/A |
| Creating customer group in app creates in Square | N/A |
| Instructs sellers to create/edit/modify segments in Square Dashboard | N/A |

---

## Invoices API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Customer profiles created with given_name, family_name, email_address | N/A |
| App cancels invoices for deleted customers appropriately | N/A |
| Order has customer ID assigned | N/A |
| Gracefully handles errors for sellers not on Invoices Plus | N/A |
| All taxes, discounts, surcharges provided to order via CreateOrder/UpdateOrder | N/A |
| Item names and prices match between Square order and app order | N/A |
| Item names and prices match between Square order and checkout page | N/A |
| Utilizes `invoice.payment_made` webhooks | N/A |
| Uses `invoice.scheduled_charge_failed` webhooks | N/A |
| Uses `invoice.canceled` webhooks | N/A |
| Uses `invoice.refunded` webhook | N/A |

---

## Gift Cards API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Purchasing gift card in Square creates gift card in partner platform | N/A |
| Balance change events cause corresponding balance change | N/A |
| CLEAR_BALANCE activities remove gift card balances | N/A |
| Square gift card can make purchases in partner platform | N/A |
| Purchases with Square gift card decrement remaining balance | N/A |
| Refunds accrue back to Square gift card | N/A |

---

## Loyalty API (If Applicable)

| Requirement | Status |
|-------------|--------|
| App doesn't attempt to create or update loyalty programs | N/A |
| Gracefully handles errors when no loyalty program set up | N/A |
| Customer profiles enrolled in Loyalty associated with phone number | N/A |
| Loyalty adjustments respect accrual definitions and promotions | N/A |
| Apps not using Square orders track loyalty promotion points | N/A |
| Handles both purchases and refunds for loyalty point totals | N/A |
| Validates phone number ownership before viewing/redeeming rewards | N/A |
| Apps allowing multiple rewards per order track balance changes | N/A |

---

## Orders API

| Requirement | Status |
|-------------|--------|
| If `schedule_type` is SCHEDULED, `pick_up_time` and `prep_time_duration` populated | ✅ |
| Recipient field contains valid identifier or display name | ✅ |
| App sets Boolean value for `is_curbside_pickup` | ✅ |
| App sends applicable refunds to Refunds API | ✅ |
| App marks orders and fulfillments as COMPLETED | ✅ |
| App uses regular CRON/Job/Task to automate syncs | ✅ |
| App uses webhooks for real-time syncs with polling as backup | ✅ |
| Accurately reflects transactions for all payment source types | ✅ |
| App deducts refunds to accurately display daily sales | ✅ |
| Custom attribute name parameter is unique per seller | ✅ |
| No sensitive/PCI data stored in custom attributes | ✅ |

---

## Payments API

| Requirement | Status |
|-------------|--------|
| Transactions in app exactly reflect transactions in Square | ✅ |
| Country/currency code set to Square account's currency | ✅ |
| App successfully creates a transaction | ✅ |
| Partner name and unique transaction/invoice ID in note parameter | ✅ |
| When payment fails or buyer navigates away, no orphaned orders | ✅ |
| Where known, app supplies `customer_id` to CreatePayment requests | ✅ |

---

## Payouts API (If Applicable)

| Requirement | Status |
|-------------|--------|
| App indicates all three payout states: SENT, FAILED, PAID | N/A |
| Handles instant deposits with associated payout_fee | N/A |
| Handles payouts with net positive value | N/A |
| Handles payouts with net negative value | N/A |
| Handles payouts with net zero value | N/A |
| Pulls in all payout entry types | N/A |

---

## Square Online / Snippets API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Square Online websites listed and selectable | N/A |
| Snippets pushed only to selected Square Online sites | N/A |
| Site name, domain, and online status shared during selection | N/A |
| App can create a snippet | N/A |
| App can edit/update a snippet | N/A |
| App can remove/delete a snippet | N/A |
| Indication provided when snippet successfully added | N/A |
| Snippet assets sufficient quality for common devices | N/A |
| Snippets work on mobile and desktop | N/A |
| No JavaScript alert/confirmation boxes or distracting behavior | N/A |
| Snippets don't ask for passwords | N/A |
| Snippet use adequately disclosed to seller | N/A |
| No user-unfriendly text (code, debug, technical errors) exposed | N/A |
| Snippets don't overly obscure major elements without recourse | N/A |
| Snippets don't overly obscure mobile elements without recourse | N/A |

---

## Subscriptions API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Disables/hides subscriptions tied to disabled SubscriptionPlanVariation | N/A |
| Subscriptions associated with customer profile including valid email | N/A |
| Buyers can see current subscription state (PENDING, ACTIVE, CANCELED) | N/A |
| App doesn't allow adding/removing/reordering subscription phases | N/A |
| Phases in SubscriptionPlanVariation match ordinals in SubscriptionPlan | N/A |
| Customers can cancel or continue pending canceled subscription | N/A |
| Customers can add/remove selected card on file | N/A |
| Customers only select card on file stored through your application | N/A |
| Uses `invoice.payment_made` webhooks for successful payments | N/A |

---

## Team API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Can sync new employees (team members) to Square | N/A |
| Can sync updated employee details to Square | N/A |
| Can sync active employees from Square | N/A |
| Can sync updated team member details from Square | N/A |
| Assigns a job to all team members created in Square | N/A |

---

## Terminal API (If Applicable)

| Requirement | Status |
|-------------|--------|
| Devices API permissions requested in OAuth (DEVICE_CREDENTIAL_MANAGEMENT) | N/A |
| Seller prompted to select location to register with Square Terminal | N/A |
| Switching locations alerts user to re-register Terminals | N/A |
| Valid device code generated by app | N/A |
| UI/UX for pairing device with device code and expiration timeline | N/A |
| App responds to checkout state changes | N/A |
| Country/currency code set to Square account's currency | N/A |
| Partner name and unique transaction/invoice ID in note parameter | N/A |
| All error states from checkout results handled | N/A |
| Buyer cancellation flow supported | N/A |
| Seller cancellation flow supported | N/A |
| App successfully creates Terminal transaction | N/A |
| Transactions in app exactly reflect transactions in Square | N/A |
| Applicable taxes show in UI before initiating Terminal checkout | N/A |
| App periodically syncs Square refunds | N/A |
| `device.code.paired` webhook surfaced to sellers in UI | N/A |
| Can refund Interac network payment with Terminal device | N/A |

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

## Compliance Plan

To maintain ongoing compliance with Square App Marketplace requirements, SqTools follows this plan:

### 1. Pre-Release Verification

- **Automated Testing**: Run integration tests covering all implemented Square API endpoints before each release
- **Error Handling Validation**: Verify all API calls handle 4XX and 5XX responses gracefully
- **Rate Limit Testing**: Confirm exponential backoff implementation with simulated rate limits
- **Pagination Testing**: Validate cursor-based pagination works correctly for all list endpoints

### 2. OAuth Security Audits

- **Quarterly Reviews**: Audit OAuth implementation for security best practices
- **Token Management**: Verify automatic token refresh occurs every 7-14 days
- **Encryption Verification**: Confirm AES-256-GCM encryption for tokens at rest
- **Secret Management**: Ensure OAuth secrets and encryption keys remain out of source control
- **CSRF Protection**: Validate state parameter implementation

### 3. Documentation Maintenance

- **User Documentation**: Review and update setup/usage guides with each feature release
- **App Listing Sync**: Ensure App Marketplace listing matches current features and capabilities
- **Support Channel Verification**: Confirm support contact information is accurate and accessible

### 4. Webhook Reliability

- **Signature Verification**: Test HMAC-SHA256 validation with each deployment
- **Event Handling**: Verify all subscribed webhook events are processed correctly
- **Deduplication**: Confirm idempotent handling of duplicate webhook deliveries
- **Revocation Response**: Test OAuth revocation webhook handling regularly

### 5. Custom Attribute Compliance

- **Data Audit**: Quarterly review to ensure no PCI or sensitive data in custom attributes
- **Uniqueness Check**: Validate custom attribute names remain unique per seller
- **Limit Monitoring**: Track custom attribute counts to stay within platform limits

### 6. API Best Practices Monitoring

- **Rate Limit Tracking**: Monitor API usage to stay within limits
- **Retry Logic Testing**: Validate exponential backoff and Retry-After header handling
- **Idempotency Key Usage**: Ensure all write operations use idempotency keys

### 7. Sync Integrity

- **Inventory Sync Validation**: Verify bidirectional inventory updates are accurate
- **Catalog Sync Testing**: Confirm item, variation, and category syncs maintain data integrity
- **Webhook + Polling Backup**: Ensure CRON jobs provide backup for real-time webhook syncs

### 8. Incident Response

- **Error Monitoring**: Track and alert on elevated error rates
- **User Communication**: Notify affected merchants of any service disruptions
- **Post-Incident Review**: Document and address root causes of compliance failures

### 9. Periodic Self-Assessment

- **Monthly**: Review error logs and user-facing error message quality
- **Quarterly**: Full compliance checklist audit against this document
- **Annually**: Complete App Marketplace recertification review

---

*Last Updated: January 2026*
