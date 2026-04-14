# Automation Patterns

This document describes how to flag automated requests and explains why certain
endpoints behave differently for automated vs human callers.

---

## Flagging a Request as Automated

Set the HTTP request header:

```
x-request-source: automation
```

Any other value (or absence of the header) is treated as a human request.

The `middleware/request-source.js` middleware attaches `req.isAutomated` (boolean)
to every incoming request before route handlers run.

---

## Why Two Modes?

Many business rules make sense to enforce strictly for automation but are better
presented as soft warnings to humans:

| Scenario | Human | Automation |
|---|---|---|
| PO total below vendor minimum | Dialog: confirm or cancel | HTTP 422 hard block |
| (future) SMS-triggered reorder | Show diff for approval | Auto-approve or reject |
| (future) Email order confirmation | Prompt for missing fields | Fail with error list |

Hard-blocking automation prevents silent bad data. Soft-warning humans keeps the
UI usable for edge cases (e.g., an add-on to an existing order already in transit).

---

## Current Callers

| Caller | Header sent? | Notes |
|---|---|---|
| Reorder page (browser) | No | Human by default |
| (planned) Cron reorder job | Yes | Must set header |
| (planned) SMS-triggered POs | Yes | Must set header |
| (planned) Email order confirm | Yes | Must set header |
| (planned) Agent-generated POs | Yes | Must set header |

---

## Endpoint Behaviour Reference

### `POST /api/purchase-orders` — below vendor minimum

**Human** (`x-request-source` absent or not `automation`):

HTTP 200 — no PO is created; frontend should confirm and resend with `force: true`:

```json
{
  "success": true,
  "warning": "below_minimum_order",
  "vendor_minimum": 150.00,
  "order_total": 75.00
}
```

**Automation** (`x-request-source: automation`):

HTTP 422 — hard block:

```json
{
  "success": false,
  "error": "Automated PO rejected: below vendor minimum",
  "code": "BELOW_VENDOR_MINIMUM",
  "vendor_minimum": 150.00,
  "order_total": 75.00
}
```

To override on the human side, resend the original request body with `"force": true`.
Automation callers must not pass `force: true`; fix the order total instead.

---

## Adding a New Automated Caller

1. Set `x-request-source: automation` on every request from the caller.
2. Handle HTTP 422 responses: log them as errors, do not silently retry.
3. Document the new caller in the table above.
4. If the caller needs a new enforcement rule, implement the branching in the
   relevant route handler following the pattern in `routes/purchase-orders.js`.
