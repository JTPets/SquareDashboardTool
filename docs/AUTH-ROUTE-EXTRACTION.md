# Auth Route Extraction Plan

`routes/auth.js` — 785 lines, all logic inline. No service layer exists.

---

## Endpoints

| Method | Path | Description | Logic location |
|--------|------|-------------|----------------|
| POST | `/login` | Authenticate user; account lockout; session regeneration | Inline (120 lines) |
| POST | `/logout` | Destroy session, clear cookie | Inline |
| GET | `/me` | Return session user info | Inline (trivial) |
| POST | `/change-password` | Verify current password, hash + store new | Inline |
| GET | `/users` | List users scoped to active merchant (admin) | Inline |
| POST | `/users` | Create user + link to merchant in transaction (admin) | Inline |
| PUT | `/users/:id` | Update name/role/is_active, merchant-scoped (admin) | Inline |
| POST | `/users/:id/reset-password` | Admin resets user password, clears lockout | Inline |
| POST | `/users/:id/unlock` | Clear lockout fields (admin) | Inline |
| POST | `/forgot-password` | Generate reset token, store SHA-256 hash (SEC-7) | Inline |
| POST | `/reset-password` | Consume token (atomic decrement), set new password | Inline |
| GET | `/verify-reset-token` | Check token validity + attempt count | Inline |

---

## Services to Create

### `services/auth/session-service.js`
- `loginUser(email, password, req)` — lookup, lockout check, password verify, attempt tracking, `session.regenerate()`
- `logoutUser(req)` — log event, `session.destroy()`

### `services/auth/password-service.js`
- `changePassword(userId, currentPassword, newPassword)` — verify old, hash new, update
- `requestPasswordReset(email, ipAddress)` — token gen, SHA-256 hash, DB store
- `resetPassword(token, newPassword, ipAddress)` — atomic decrement, hash, update user
- `verifyResetToken(token)` — hash lookup, return validity + email

### `services/auth/account-service.js`
- `listUsers(merchantId)` — merchant-scoped user list
- `createUser(data, merchantId)` — email check, hash, transaction (insert + link)
- `updateUser(userId, merchantId, changes)` — dynamic update query, self-deactivate guard
- `resetUserPassword(userId, merchantId, newPassword?)` — generate if absent, hash, clear lockout
- `unlockUser(userId, merchantId)` — clear `failed_login_attempts` / `locked_until`

---

## Test Coverage

All 12 endpoints are tested in `__tests__/routes/auth.test.js` (~53 cases):

| Endpoint | Tests |
|----------|-------|
| POST /login | 9 |
| POST /logout | 2 |
| GET /me | 2 |
| POST /change-password | 5 |
| GET /users | 4 |
| POST /users | 6 |
| PUT /users/:id | 5 |
| POST /users/:id/reset-password | 4 |
| POST /users/:id/unlock | 3 |
| POST /forgot-password | 4 |
| POST /reset-password | 5 |
| GET /verify-reset-token | 4 |

**No service unit tests exist yet.** Estimate ~35 new tests needed across the three service files.

---

## Security-Sensitive Logic (Extra Care Required)

1. **Session fixation** (`/login`): `req.session.regenerate()` callback chain must be preserved exactly — session data set *after* regeneration, `session.save()` before response.
2. **Token hashing** (SEC-7): `hashResetToken()` from `utils/hash-utils.js` — plaintext sent to user, SHA-256 stored. Never log or return the hash.
3. **Atomic attempt decrement** (`/reset-password`): `attempts_remaining` decremented *before* password update to prevent brute-force even on partial failures.
4. **Account lockout**: constants `MAX_FAILED_ATTEMPTS = 5`, `LOCKOUT_DURATION_MINUTES = 30` — must remain configurable or at least visible at the service boundary.
5. **Anti-enumeration**: `/login` and `/forgot-password` return generic messages regardless of whether the user exists — do not change error text during extraction.
6. **Password utilities**: `hashPassword` / `verifyPassword` from `utils/password` (bcrypt) — no reimplementation; services just call through.
