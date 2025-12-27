# Phase 1: Security Implementation Plan
## Multi-User Authentication System

**Goal:** Secure the application for internet deployment with multi-user support.

---

## Overview

### What Will Be Built

```
┌─────────────────────────────────────────────────────────────┐
│                    Request Flow                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Browser Request                                            │
│        │                                                     │
│        ▼                                                     │
│   ┌─────────────┐                                           │
│   │ Rate Limiter│  ← Block if too many requests             │
│   └──────┬──────┘                                           │
│          │                                                   │
│          ▼                                                   │
│   ┌─────────────┐                                           │
│   │   Helmet    │  ← Add security headers                   │
│   └──────┬──────┘                                           │
│          │                                                   │
│          ▼                                                   │
│   ┌─────────────┐                                           │
│   │    CORS     │  ← Check origin is allowed                │
│   └──────┬──────┘                                           │
│          │                                                   │
│          ▼                                                   │
│   ┌─────────────────────────────────────┐                   │
│   │  Is this a public route?            │                   │
│   │  (/login, /api/auth/*, static files)│                   │
│   └──────┬──────────────────┬───────────┘                   │
│          │                  │                                │
│         YES                 NO                               │
│          │                  │                                │
│          ▼                  ▼                                │
│   ┌──────────┐      ┌─────────────┐                         │
│   │  Allow   │      │ Check Session│                        │
│   │ Request  │      │ (logged in?) │                        │
│   └──────────┘      └──────┬──────┘                         │
│                            │                                 │
│                   ┌────────┴────────┐                       │
│                   │                 │                        │
│                 Valid            Invalid                     │
│                   │                 │                        │
│                   ▼                 ▼                        │
│            ┌──────────┐      ┌───────────┐                  │
│            │  Allow   │      │ Redirect  │                  │
│            │ Request  │      │ to Login  │                  │
│            └──────────┘      └───────────┘                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Components to Build

### 1. Database Schema

```sql
-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user',  -- 'admin', 'user', 'readonly'
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (for persistent sessions)
CREATE TABLE sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP NOT NULL
);
CREATE INDEX idx_sessions_expire ON sessions(expire);

-- Optional: Audit log for security events
CREATE TABLE auth_audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    event_type VARCHAR(50) NOT NULL,  -- 'login', 'logout', 'failed_login', 'password_change'
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. User Roles & Permissions

| Role | Permissions |
|------|-------------|
| `admin` | Full access: view/edit all data, manage users, view/edit settings |
| `user` | Standard access: view/edit inventory, sync, manage GMC |
| `readonly` | View only: can see data but not modify |

### 3. NPM Packages Required

```json
{
  "dependencies": {
    "bcrypt": "^5.1.1",              // Password hashing
    "express-session": "^1.18.0",    // Session management
    "connect-pg-simple": "^9.0.1",   // Store sessions in PostgreSQL
    "helmet": "^7.1.0",              // Security headers
    "express-rate-limit": "^7.1.5",  // Rate limiting
    "express-validator": "^7.0.1"    // Input validation
  }
}
```

### 4. New Files to Create

```
middleware/
├── auth.js              # Authentication middleware
├── rate-limit.js        # Rate limiting configuration
└── security-headers.js  # Helmet configuration

routes/
└── auth.js              # Login/logout/user management routes

public/
└── login.html           # Login page

utils/
└── password.js          # Password hashing utilities
```

### 5. API Endpoints

#### Authentication Routes (Public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/logout` | Logout (destroy session) |
| GET | `/api/auth/me` | Get current user info |
| POST | `/api/auth/change-password` | Change own password |

#### Admin-Only Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create new user |
| PUT | `/api/admin/users/:id` | Update user |
| DELETE | `/api/admin/users/:id` | Deactivate user |
| GET | `/api/settings/env` | View environment settings |
| PUT | `/api/settings/env` | Update environment settings |

### 6. Login Page

Simple, clean login form:
- Email input
- Password input
- "Remember me" checkbox (optional)
- Login button
- Error message display

### 7. Session Configuration

```javascript
// Session settings
{
    secret: process.env.SESSION_SECRET,  // Random 32+ char string
    resave: false,
    saveUninitialized: false,
    store: pgSession,                     // PostgreSQL session store
    cookie: {
        secure: process.env.NODE_ENV === 'production',  // HTTPS only in prod
        httpOnly: true,                    // No JavaScript access
        maxAge: 24 * 60 * 60 * 1000,      // 24 hours
        sameSite: 'strict'                 // CSRF protection
    }
}
```

---

## Environment Variables (New)

Add to `.env`:

```env
# Session Security
SESSION_SECRET=generate-a-random-32-character-string-here

# Initial Admin User (created on first run)
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=change-this-immediately

# Security Settings
RATE_LIMIT_WINDOW_MS=900000       # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100       # Max requests per window
LOGIN_RATE_LIMIT_MAX=5            # Max login attempts per 15 min
```

---

## Implementation Order

### Step 1: Install Dependencies
```bash
npm install bcrypt express-session connect-pg-simple helmet express-rate-limit express-validator
```

### Step 2: Create Database Tables
Run migration to create `users` and `sessions` tables.

### Step 3: Create Middleware
- `middleware/auth.js` - Session check, require login
- `middleware/rate-limit.js` - Rate limiting
- `middleware/security-headers.js` - Helmet config

### Step 4: Create Auth Routes
- Login, logout, password change
- User management (admin only)

### Step 5: Create Login Page
Simple HTML/CSS login form.

### Step 6: Protect Existing Routes
Apply auth middleware to all `/api/*` routes.

### Step 7: Update Settings Endpoint
Require admin role to access `/api/settings/env`.

### Step 8: Create Initial Admin User
On first startup, create admin user from env vars.

### Step 9: Test Everything
- Login/logout flow
- Protected routes
- Rate limiting
- Session persistence

---

## Security Features Included

| Feature | Protection Against |
|---------|-------------------|
| Password hashing (bcrypt) | Password theft if DB leaked |
| Session cookies (httpOnly) | XSS session hijacking |
| Rate limiting | Brute force attacks |
| CSRF protection (sameSite) | Cross-site request forgery |
| Security headers (helmet) | XSS, clickjacking, MIME sniffing |
| Role-based access | Unauthorized actions |
| Audit logging | Forensics, compliance |
| Session expiry | Stale session attacks |

---

## Questions Before Implementation

1. **Session Duration:**
   - How long should users stay logged in? (Default: 24 hours)
   - Allow "remember me" for longer sessions? (7 days?)

2. **Password Policy:**
   - Minimum length? (Recommend: 8 characters)
   - Require complexity? (uppercase, number, symbol?)

3. **User Self-Registration:**
   - Should users be able to create their own accounts?
   - Or admin-only user creation?

4. **Email Verification:**
   - Require email verification for new accounts?
   - Password reset via email?

5. **Two-Factor Authentication (2FA):**
   - Want to add 2FA later? (Can design for it now)

6. **Allowed Origins (CORS):**
   - What domains will access this app?
   - Just the main domain, or multiple?

---

## Estimated Time

| Task | Time |
|------|------|
| Database schema + migration | 30 min |
| Auth middleware | 1 hour |
| Login page | 30 min |
| Auth API routes | 1 hour |
| Protect existing routes | 1 hour |
| Rate limiting + helmet | 30 min |
| Testing | 1 hour |
| **Total** | **~5-6 hours** |

---

## After Phase 1

Once Phase 1 is complete, you'll have:
- Secure login system with multiple users
- Role-based access control
- Protected API endpoints
- Rate limiting
- Security headers
- Session management
- Audit logging

This provides a solid foundation for:
- Phase 2: HTTPS/SSL (via nginx reverse proxy)
- Phase 3: Additional hardening (2FA, email verification)
- Phase 4: Production deployment

---

## Ready to Proceed?

Review this plan and let me know:
1. Answers to the questions above
2. Any changes or additions you want
3. When you're ready to start implementation
