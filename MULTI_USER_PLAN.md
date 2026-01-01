# Multi-User Account Isolation Plan
## Square App Marketplace Readiness

**Document Version:** 2.1
**Created:** December 28, 2025
**Last Updated:** January 1, 2026
**Status:** Phase 1-4 IN PROGRESS - Frontend Updates Started

---

## Executive Summary

This document outlines the comprehensive plan to transform the Square Dashboard Tool from a single-tenant application into a multi-tenant SaaS solution ready for the Square App Marketplace. The current architecture uses a single Square access token for all users, meaning all data is shared. The goal is to enable complete account isolation where each Square merchant has their own isolated data environment.

### Progress Summary

| Component | Status | Notes |
|-----------|--------|-------|
| User Authentication | ✅ COMPLETE | Login, logout, roles, audit logging |
| Session Management | ✅ COMPLETE | PostgreSQL-backed sessions |
| Landing Page | ✅ COMPLETE | Public marketing page separated from dashboard |
| Dashboard Restructure | ✅ COMPLETE | User homepage at /dashboard.html |
| Database Multi-Tenant Schema | ✅ COMPLETE | Migration + startup validation |
| Square OAuth Routes | ✅ COMPLETE | routes/square-oauth.js |
| Token Encryption | ✅ COMPLETE | utils/token-encryption.js (AES-256-GCM) |
| Merchant Context Middleware | ✅ COMPLETE | middleware/merchant.js |
| MerchantDB Wrapper | ✅ COMPLETE | utils/merchant-db.js |
| Startup Schema Validation | ✅ COMPLETE | utils/database.js auto-creates tables |
| Merchant Management API | ✅ COMPLETE | /api/merchants endpoints in server.js |
| API Layer Updates | ✅ COMPLETE | All ~100+ endpoints updated with merchant filtering |
| Merchant Management UI | ✅ COMPLETE | merchants.html page created |
| Dashboard Merchant Context | ✅ COMPLETE | Header shows business name, no-merchant overlay |
| Square Referral Integration | ✅ COMPLETE | Referral links on dashboard, login, support pages |

### Files Created/Modified (Phase 1-4)

| File | Type | Purpose |
|------|------|---------|
| `database/migrations/005_multi_tenant.sql` | New | Schema migration |
| `database/migrations/005_multi_tenant_rollback.sql` | New | Rollback script |
| `utils/token-encryption.js` | New | AES-256-GCM token encryption |
| `routes/square-oauth.js` | New | OAuth flow endpoints |
| `middleware/merchant.js` | New | Merchant context middleware |
| `utils/merchant-db.js` | New | Tenant-isolated DB wrapper |
| `utils/database.js` | Modified | Added startup schema validation |
| `server.js` | Modified | Registered routes & middleware |
| `.env.example` | Modified | Added OAuth env vars |
| `package.json` | Modified | Added `square` SDK dependency |
| `public/merchants.html` | New | Merchant management UI |
| `public/dashboard.html` | Modified | Added merchant context header, no-merchant overlay |
| `public/login.html` | Modified | Added Square referral link |
| `public/support.html` | Modified | Added Square referral section |

---

## Development Standards & Safeguards

### ⚠️ MANDATORY CHECKLIST FOR ALL CHANGES

When adding new features that involve database, dependencies, or configuration:

#### 1. Database Changes
- [ ] Create migration file in `database/migrations/XXX_name.sql`
- [ ] Create rollback file in `database/migrations/XXX_name_rollback.sql`
- [ ] **Add tables/columns to `utils/database.js` → `ensureSchema()`** for new installs
- [ ] Test migration on staging before production
- [ ] Verify rollback works

#### 2. New Dependencies
- [ ] **Add to `package.json` dependencies** (not just `npm install`)
- [ ] Commit `package.json` changes
- [ ] Document why the dependency is needed
- [ ] Check for security vulnerabilities: `npm audit`

#### 3. Environment Variables
- [ ] **Add to `.env.example`** with clear documentation
- [ ] Add validation in code for required variables
- [ ] Document in this plan if related to multi-tenant
- [ ] Never commit actual secrets to git

#### 4. New API Endpoints
- [ ] Add `requireAuth` middleware for protected routes
- [ ] Add `requireMerchant` middleware for tenant-scoped routes
- [ ] Use `MerchantDB` wrapper for database queries
- [ ] Document in API section of this plan

### Key Files That Must Stay In Sync

| When you change... | Also update... |
|-------------------|----------------|
| Database schema | `utils/database.js` ensureSchema() |
| New npm package | `package.json` dependencies |
| New env variable | `.env.example` |
| New API endpoint | This planning document |
| OAuth scopes | `routes/square-oauth.js` REQUIRED_SCOPES |

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Target Architecture](#2-target-architecture)
3. [Phase 1: Database Schema Changes](#3-phase-1-database-schema-changes)
4. [Phase 2: Square OAuth Implementation](#4-phase-2-square-oauth-implementation)
5. [Phase 3: API Layer Multi-Tenancy](#5-phase-3-api-layer-multi-tenancy)
6. [Phase 4: Frontend Updates](#6-phase-4-frontend-updates)
7. [Phase 5: Security & Compliance](#7-phase-5-security--compliance)
8. [Phase 6: Square Marketplace Requirements](#8-phase-6-square-marketplace-requirements)
9. [Migration Strategy](#9-migration-strategy)
10. [Testing Strategy](#10-testing-strategy)
11. [Implementation Checklist](#11-implementation-checklist)
12. [Error-Prone Areas & Safeguards](#12-error-prone-areas--safeguards)
13. [Pre-Flight Checklists](#13-pre-flight-checklists)
14. [Trial Launch Readiness](#14-trial-launch-readiness)

---

## 1. Current State Analysis

### 1.1 Architecture Overview

| Component | Current State | Status | Action Required |
|-----------|--------------|--------|-----------------|
| User Authentication | Full auth system with login, roles, audit | ✅ DONE | None |
| Session Management | PostgreSQL-backed with connect-pg-simple | ✅ DONE | None |
| Landing Page | Public marketing page at / | ✅ DONE | None |
| Dashboard | User homepage at /dashboard.html | ✅ DONE | Add merchant context |
| Square Auth | Single `SQUARE_ACCESS_TOKEN` in .env | ⏳ TODO | OAuth per merchant |
| Database | 25+ tables with no tenant isolation | ⏳ TODO | Add merchant_id everywhere |
| API Layer | 111 endpoints with no merchant filtering | ⏳ TODO | Add merchant filtering |
| User-Merchant Link | Users exist but aren't linked to merchants | ⏳ TODO | Create user_merchants table |

### 1.2 What's Already Working

These components are **production-ready** and require no changes:

#### Authentication System (`middleware/auth.js`, `routes/auth.js`)
- ✅ Session-based authentication with PostgreSQL storage
- ✅ Role-based access control (admin, user, readonly)
- ✅ Account lockout after 5 failed attempts (30 min)
- ✅ Audit logging to `auth_audit_log` table
- ✅ Password strength validation
- ✅ Secure session cookies (httpOnly, sameSite)

#### User Management
- ✅ Admin can create/update/delete users
- ✅ Password reset functionality
- ✅ Account unlock capability

#### Frontend Structure
- ✅ Public landing page (`/index.html`) - marketing content
- ✅ Login page (`/login.html`) - redirects to dashboard after auth
- ✅ Dashboard (`/dashboard.html`) - authenticated user homepage
- ✅ All 18 tool pages updated with navigation to dashboard

### 1.3 Critical Files

| File | Lines | Purpose | Impact Level |
|------|-------|---------|--------------|
| `server.js` | 8,125 | All API endpoints | **CRITICAL** - 100+ query changes |
| `utils/square-api.js` | ~3,000 | Square API integration | **CRITICAL** - Token per merchant |
| `database/schema.sql` | ~1,000 | Database schema | **CRITICAL** - Add merchant_id everywhere |
| `middleware/auth.js` | ~200 | Authentication | **HIGH** - Add merchant context |
| `routes/auth.js` | ~300 | Auth endpoints | **HIGH** - User-merchant linking |
| All 21 HTML files | ~15,000 | Frontend pages | **MEDIUM** - Merchant context |

### 1.4 Data Tables Requiring Isolation

All 25+ tables need `merchant_id` column:

**Core Data Tables:**
- `items` - Products from Square catalog
- `variations` - Product SKUs/variations
- `categories` - Product categories
- `images` - Product images
- `locations` - Store locations
- `inventory_counts` - Stock levels

**Business Logic Tables:**
- `vendors` - Supplier information
- `variation_vendors` - Vendor pricing
- `vendor_catalog_items` - Imported vendor catalogs
- `purchase_orders` - Purchase orders
- `purchase_order_items` - PO line items
- `sales_velocity` - Sales analytics

**Feature Tables:**
- `variation_expiration` - Expiration dates
- `expiry_discount_tiers` - Discount rules
- `variation_discount_status` - Current discounts
- `expiry_discount_audit_log` - Audit trail
- `expiry_discount_settings` - Settings per merchant
- `brands` - Product brands
- `google_taxonomy` - Google taxonomy (shared)
- `category_taxonomy_mapping` - Category mappings
- `item_brands` - Brand assignments
- `gmc_settings` - GMC configuration
- `gmc_feed_history` - Feed history

**Operational Tables:**
- `count_history` - Cycle count records
- `count_queue_priority` - Priority counts
- `count_queue_daily` - Daily batches
- `count_sessions` - Count sessions
- `variation_location_settings` - Location settings
- `sync_history` - Sync logs

---

## 2. Target Architecture

### 2.1 Multi-Tenant Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     Square App Marketplace                       │
│                                                                   │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐      │
│  │ Merchant │   │ Merchant │   │ Merchant │   │ Merchant │      │
│  │    A     │   │    B     │   │    C     │   │    N     │      │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘      │
│       │              │              │              │              │
│       └──────────────┴──────────────┴──────────────┘              │
│                              │                                    │
│                              ▼                                    │
│                    ┌─────────────────┐                           │
│                    │  Square OAuth   │                           │
│                    │   (Per Merchant)│                           │
│                    └────────┬────────┘                           │
└─────────────────────────────┼─────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Square Dashboard Tool                          │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    API Layer                               │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │ Auth        │  │ Merchant    │  │ Request         │   │  │
│  │  │ Middleware  │──│ Middleware  │──│ Handler         │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                    │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │              Isolated Data per Merchant                    │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │                    Database                          │  │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │  │  │
│  │  │  │Merchant A│  │Merchant B│  │Merchant C│          │  │  │
│  │  │  │  Data    │  │  Data    │  │  Data    │          │  │  │
│  │  │  └──────────┘  └──────────┘  └──────────┘          │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Core Principles

1. **Complete Data Isolation** - Merchant A cannot access Merchant B's data under any circumstances
2. **Token Security** - Each merchant's Square tokens encrypted at rest
3. **Row-Level Security** - All queries automatically filtered by merchant_id
4. **Audit Trail** - All actions logged with merchant context
5. **Graceful Degradation** - Handle token expiry/revocation gracefully

---

## 3. Phase 1: Database Schema Changes

### 3.1 New Tables

```sql
-- =============================================================================
-- MERCHANTS TABLE - Core tenant table
-- =============================================================================
CREATE TABLE merchants (
    id SERIAL PRIMARY KEY,

    -- Identity
    square_merchant_id TEXT UNIQUE NOT NULL,  -- Square's merchant ID
    business_name TEXT NOT NULL,
    business_email TEXT,

    -- Square OAuth tokens (encrypted)
    square_access_token TEXT NOT NULL,        -- Encrypted
    square_refresh_token TEXT,                -- Encrypted
    square_token_expires_at TIMESTAMP,
    square_token_scopes TEXT[],               -- Array of granted scopes

    -- Subscription status
    subscription_status TEXT DEFAULT 'trial', -- trial, active, cancelled, expired
    subscription_plan_id INTEGER,
    trial_ends_at TIMESTAMP,
    subscription_ends_at TIMESTAMP,

    -- Settings
    timezone TEXT DEFAULT 'America/New_York',
    currency TEXT DEFAULT 'USD',
    settings JSONB DEFAULT '{}',              -- Flexible per-merchant settings

    -- Metadata
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_sync_at TIMESTAMP,

    -- Constraints
    CONSTRAINT valid_subscription_status CHECK (
        subscription_status IN ('trial', 'active', 'cancelled', 'expired', 'suspended')
    )
);

CREATE INDEX idx_merchants_square_id ON merchants(square_merchant_id);
CREATE INDEX idx_merchants_subscription ON merchants(subscription_status, is_active);

-- =============================================================================
-- USER-MERCHANT RELATIONSHIPS
-- =============================================================================
CREATE TABLE user_merchants (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'user',        -- owner, admin, user, readonly
    is_primary BOOLEAN DEFAULT false,         -- Primary merchant for user
    invited_by INTEGER REFERENCES users(id),
    invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP,

    UNIQUE(user_id, merchant_id),
    CONSTRAINT valid_role CHECK (role IN ('owner', 'admin', 'user', 'readonly'))
);

CREATE INDEX idx_user_merchants_user ON user_merchants(user_id);
CREATE INDEX idx_user_merchants_merchant ON user_merchants(merchant_id);

-- =============================================================================
-- MERCHANT INVITATIONS
-- =============================================================================
CREATE TABLE merchant_invitations (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    token TEXT UNIQUE NOT NULL,
    invited_by INTEGER REFERENCES users(id),
    expires_at TIMESTAMP NOT NULL,
    accepted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_merchant_invitations_token ON merchant_invitations(token);
CREATE INDEX idx_merchant_invitations_email ON merchant_invitations(email);

-- =============================================================================
-- OAUTH STATE TABLE (for OAuth flow security)
-- =============================================================================
CREATE TABLE oauth_states (
    id SERIAL PRIMARY KEY,
    state TEXT UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    redirect_uri TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP
);

CREATE INDEX idx_oauth_states_state ON oauth_states(state);
```

### 3.2 Schema Modifications

Add `merchant_id` to all existing tables:

```sql
-- =============================================================================
-- ADD MERCHANT_ID TO ALL EXISTING TABLES
-- =============================================================================

-- Core catalog tables
ALTER TABLE locations ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE categories ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE items ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variations ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE images ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE inventory_counts ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- Vendor tables
ALTER TABLE vendors ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_vendors ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE vendor_catalog_items ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- Purchase order tables
ALTER TABLE purchase_orders ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE purchase_order_items ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- Sales & analytics
ALTER TABLE sales_velocity ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_location_settings ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- Cycle count tables
ALTER TABLE count_history ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE count_queue_priority ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE count_queue_daily ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE count_sessions ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- Expiration tables
ALTER TABLE variation_expiration ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE expiry_discount_tiers ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_discount_status ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE expiry_discount_audit_log ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE expiry_discount_settings ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- GMC tables
ALTER TABLE brands ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE category_taxonomy_mapping ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE item_brands ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE gmc_settings ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE gmc_feed_history ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- System tables
ALTER TABLE sync_history ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE auth_audit_log ADD COLUMN merchant_id INTEGER;

-- =============================================================================
-- CREATE INDEXES FOR MERCHANT FILTERING
-- =============================================================================

CREATE INDEX idx_locations_merchant ON locations(merchant_id);
CREATE INDEX idx_categories_merchant ON categories(merchant_id);
CREATE INDEX idx_items_merchant ON items(merchant_id);
CREATE INDEX idx_variations_merchant ON variations(merchant_id);
CREATE INDEX idx_images_merchant ON images(merchant_id);
CREATE INDEX idx_inventory_counts_merchant ON inventory_counts(merchant_id);
CREATE INDEX idx_vendors_merchant ON vendors(merchant_id);
CREATE INDEX idx_variation_vendors_merchant ON variation_vendors(merchant_id);
CREATE INDEX idx_vendor_catalog_items_merchant ON vendor_catalog_items(merchant_id);
CREATE INDEX idx_purchase_orders_merchant ON purchase_orders(merchant_id);
CREATE INDEX idx_purchase_order_items_merchant ON purchase_order_items(merchant_id);
CREATE INDEX idx_sales_velocity_merchant ON sales_velocity(merchant_id);
CREATE INDEX idx_variation_location_settings_merchant ON variation_location_settings(merchant_id);
CREATE INDEX idx_count_history_merchant ON count_history(merchant_id);
CREATE INDEX idx_count_queue_priority_merchant ON count_queue_priority(merchant_id);
CREATE INDEX idx_count_queue_daily_merchant ON count_queue_daily(merchant_id);
CREATE INDEX idx_count_sessions_merchant ON count_sessions(merchant_id);
CREATE INDEX idx_variation_expiration_merchant ON variation_expiration(merchant_id);
CREATE INDEX idx_expiry_discount_tiers_merchant ON expiry_discount_tiers(merchant_id);
CREATE INDEX idx_variation_discount_status_merchant ON variation_discount_status(merchant_id);
CREATE INDEX idx_expiry_discount_audit_log_merchant ON expiry_discount_audit_log(merchant_id);
CREATE INDEX idx_expiry_discount_settings_merchant ON expiry_discount_settings(merchant_id);
CREATE INDEX idx_brands_merchant ON brands(merchant_id);
CREATE INDEX idx_category_taxonomy_mapping_merchant ON category_taxonomy_mapping(merchant_id);
CREATE INDEX idx_item_brands_merchant ON item_brands(merchant_id);
CREATE INDEX idx_gmc_settings_merchant ON gmc_settings(merchant_id);
CREATE INDEX idx_gmc_feed_history_merchant ON gmc_feed_history(merchant_id);
CREATE INDEX idx_sync_history_merchant ON sync_history(merchant_id);

-- =============================================================================
-- COMPOSITE INDEXES FOR COMMON QUERIES
-- =============================================================================

CREATE INDEX idx_items_merchant_deleted ON items(merchant_id, is_deleted);
CREATE INDEX idx_variations_merchant_item ON variations(merchant_id, item_id);
CREATE INDEX idx_inventory_merchant_location ON inventory_counts(merchant_id, location_id);
CREATE INDEX idx_purchase_orders_merchant_status ON purchase_orders(merchant_id, status);
CREATE INDEX idx_sales_velocity_merchant_location ON sales_velocity(merchant_id, location_id);
```

### 3.3 Row Level Security (Optional - PostgreSQL RLS)

```sql
-- Enable row level security on all tables
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE variations ENABLE ROW LEVEL SECURITY;
-- ... repeat for all tables

-- Create policy for merchant isolation
CREATE POLICY merchant_isolation ON items
    USING (merchant_id = current_setting('app.current_merchant_id')::INTEGER);

-- Application sets this before each request:
-- SET app.current_merchant_id = '123';
```

---

## 4. Phase 2: Square OAuth Implementation

### 4.1 Square OAuth Flow

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   User      │     │  Dashboard App  │     │   Square API    │
│  (Browser)  │     │    (Backend)    │     │                 │
└──────┬──────┘     └────────┬────────┘     └────────┬────────┘
       │                     │                       │
       │  1. Click "Connect  │                       │
       │     Square Account" │                       │
       │────────────────────>│                       │
       │                     │                       │
       │                     │  2. Generate state,   │
       │                     │     store in DB       │
       │                     │                       │
       │  3. Redirect to     │                       │
       │     Square OAuth    │                       │
       │<────────────────────│                       │
       │                     │                       │
       │  4. User authorizes │                       │
       │     on Square.com   │                       │
       │─────────────────────────────────────────────>
       │                     │                       │
       │  5. Redirect back   │                       │
       │     with code       │                       │
       │────────────────────>│                       │
       │                     │                       │
       │                     │  6. Exchange code     │
       │                     │     for tokens        │
       │                     │──────────────────────>│
       │                     │                       │
       │                     │  7. Return tokens &   │
       │                     │     merchant info     │
       │                     │<──────────────────────│
       │                     │                       │
       │                     │  8. Encrypt & store   │
       │                     │     tokens in DB      │
       │                     │                       │
       │                     │  9. Create merchant   │
       │                     │     record            │
       │                     │                       │
       │  10. Success!       │                       │
       │<────────────────────│                       │
       │                     │                       │
```

### 4.2 OAuth Configuration

**Required Environment Variables:**
```env
# Square OAuth (App Marketplace)
SQUARE_APPLICATION_ID=sq0idp-xxxxx
SQUARE_APPLICATION_SECRET=sq0csp-xxxxx
SQUARE_OAUTH_REDIRECT_URI=https://yourdomain.com/api/square/oauth/callback
SQUARE_ENVIRONMENT=production

# Token encryption
TOKEN_ENCRYPTION_KEY=32-byte-hex-key-for-aes-256-encryption
```

**Square Developer Dashboard Setup:**
1. Create OAuth application at https://developer.squareup.com
2. Set OAuth redirect URI
3. Configure required OAuth scopes:
   - `MERCHANT_PROFILE_READ` - Read business info
   - `ITEMS_READ` - Read catalog
   - `ITEMS_WRITE` - Update catalog/custom attributes
   - `INVENTORY_READ` - Read inventory
   - `INVENTORY_WRITE` - Update inventory counts
   - `ORDERS_READ` - Read orders for sales velocity
   - `PAYMENTS_READ` - (If needed for order details)

### 4.3 OAuth Implementation Files

**New file: `routes/square-oauth.js`**
```javascript
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Client, Environment } = require('square');

// OAuth initiation
router.get('/connect', requireAuth, async (req, res) => {
    const state = crypto.randomBytes(32).toString('hex');

    // Store state in database with expiry
    await db.query(`
        INSERT INTO oauth_states (state, user_id, redirect_uri, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
    `, [state, req.session.user.id, req.query.redirect || '/dashboard']);

    const scopes = [
        'MERCHANT_PROFILE_READ',
        'ITEMS_READ',
        'ITEMS_WRITE',
        'INVENTORY_READ',
        'INVENTORY_WRITE',
        'ORDERS_READ'
    ];

    const authUrl = `https://connect.squareup.com/oauth2/authorize?` +
        `client_id=${process.env.SQUARE_APPLICATION_ID}&` +
        `scope=${scopes.join('+')}&` +
        `session=false&` +
        `state=${state}`;

    res.redirect(authUrl);
});

// OAuth callback
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.redirect('/settings?error=' + encodeURIComponent(error));
    }

    // Verify state
    const stateRecord = await db.query(`
        SELECT * FROM oauth_states
        WHERE state = $1 AND expires_at > NOW() AND used_at IS NULL
    `, [state]);

    if (stateRecord.rows.length === 0) {
        return res.redirect('/settings?error=invalid_state');
    }

    // Mark state as used
    await db.query('UPDATE oauth_states SET used_at = NOW() WHERE state = $1', [state]);

    // Exchange code for tokens
    const client = new Client({ environment: Environment.Production });
    const response = await client.oAuthApi.obtainToken({
        clientId: process.env.SQUARE_APPLICATION_ID,
        clientSecret: process.env.SQUARE_APPLICATION_SECRET,
        grantType: 'authorization_code',
        code: code
    });

    const { accessToken, refreshToken, expiresAt, merchantId } = response.result;

    // Get merchant info from Square
    const merchantClient = new Client({
        environment: Environment.Production,
        accessToken: accessToken
    });
    const merchantInfo = await merchantClient.merchantsApi.retrieveMerchant(merchantId);

    // Encrypt tokens
    const encryptedAccessToken = encryptToken(accessToken);
    const encryptedRefreshToken = encryptToken(refreshToken);

    // Create or update merchant record
    const merchant = await db.query(`
        INSERT INTO merchants (
            square_merchant_id,
            business_name,
            business_email,
            square_access_token,
            square_refresh_token,
            square_token_expires_at,
            square_token_scopes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (square_merchant_id) DO UPDATE SET
            square_access_token = $4,
            square_refresh_token = $5,
            square_token_expires_at = $6,
            updated_at = NOW()
        RETURNING id
    `, [
        merchantId,
        merchantInfo.result.merchant.businessName,
        merchantInfo.result.merchant.mainLocationId, // Use as contact
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt,
        scopes
    ]);

    // Link user to merchant as owner
    await db.query(`
        INSERT INTO user_merchants (user_id, merchant_id, role, is_primary, accepted_at)
        VALUES ($1, $2, 'owner', true, NOW())
        ON CONFLICT (user_id, merchant_id) DO NOTHING
    `, [stateRecord.rows[0].user_id, merchant.rows[0].id]);

    res.redirect(stateRecord.rows[0].redirect_uri || '/dashboard');
});

module.exports = router;
```

### 4.4 Token Encryption

**New file: `utils/token-encryption.js`**
```javascript
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
    const key = process.env.TOKEN_ENCRYPTION_KEY;
    if (!key || key.length !== 64) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    }
    return Buffer.from(key, 'hex');
}

function encryptToken(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decryptToken(encrypted) {
    const [ivHex, authTagHex, ciphertext] = encrypted.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

module.exports = { encryptToken, decryptToken };
```

### 4.5 Token Refresh

```javascript
async function refreshMerchantToken(merchantId) {
    const merchant = await db.query(
        'SELECT * FROM merchants WHERE id = $1',
        [merchantId]
    );

    if (!merchant.rows[0]) {
        throw new Error('Merchant not found');
    }

    const refreshToken = decryptToken(merchant.rows[0].square_refresh_token);

    const client = new Client({ environment: Environment.Production });
    const response = await client.oAuthApi.obtainToken({
        clientId: process.env.SQUARE_APPLICATION_ID,
        clientSecret: process.env.SQUARE_APPLICATION_SECRET,
        grantType: 'refresh_token',
        refreshToken: refreshToken
    });

    const { accessToken, refreshToken: newRefreshToken, expiresAt } = response.result;

    await db.query(`
        UPDATE merchants SET
            square_access_token = $1,
            square_refresh_token = $2,
            square_token_expires_at = $3,
            updated_at = NOW()
        WHERE id = $4
    `, [
        encryptToken(accessToken),
        encryptToken(newRefreshToken),
        expiresAt,
        merchantId
    ]);

    return accessToken;
}
```

---

## 5. Phase 3: API Layer Multi-Tenancy

### 5.1 Merchant Context Middleware

**New file: `middleware/merchant.js`**
```javascript
const { decryptToken } = require('../utils/token-encryption');

/**
 * Middleware to load merchant context from session
 * Must be applied AFTER auth middleware
 */
async function loadMerchantContext(req, res, next) {
    if (!req.session.user) {
        return next();
    }

    try {
        // Get active merchant from session or query user's primary merchant
        let merchantId = req.session.activeMerchantId;

        if (!merchantId) {
            const result = await db.query(`
                SELECT um.merchant_id, m.business_name, m.square_merchant_id
                FROM user_merchants um
                JOIN merchants m ON m.id = um.merchant_id
                WHERE um.user_id = $1 AND um.is_primary = true AND m.is_active = true
                LIMIT 1
            `, [req.session.user.id]);

            if (result.rows.length === 0) {
                // User has no merchants - they need to connect one
                req.merchantContext = null;
                return next();
            }

            merchantId = result.rows[0].merchant_id;
            req.session.activeMerchantId = merchantId;
        }

        // Load full merchant context
        const merchant = await db.query(`
            SELECT
                m.*,
                um.role as user_role
            FROM merchants m
            JOIN user_merchants um ON um.merchant_id = m.id
            WHERE m.id = $1 AND um.user_id = $2 AND m.is_active = true
        `, [merchantId, req.session.user.id]);

        if (merchant.rows.length === 0) {
            req.session.activeMerchantId = null;
            req.merchantContext = null;
            return next();
        }

        req.merchantContext = {
            id: merchant.rows[0].id,
            squareMerchantId: merchant.rows[0].square_merchant_id,
            businessName: merchant.rows[0].business_name,
            userRole: merchant.rows[0].user_role,
            subscriptionStatus: merchant.rows[0].subscription_status,
            settings: merchant.rows[0].settings || {}
        };

        next();
    } catch (error) {
        console.error('Error loading merchant context:', error);
        next(error);
    }
}

/**
 * Middleware to require merchant context
 * Returns 403 if user has no active merchant
 */
function requireMerchant(req, res, next) {
    if (!req.merchantContext) {
        return res.status(403).json({
            error: 'No merchant connected',
            code: 'NO_MERCHANT',
            message: 'Please connect your Square account first'
        });
    }
    next();
}

/**
 * Get Square client for current merchant
 * Automatically handles token refresh
 */
async function getSquareClientForMerchant(merchantId) {
    const merchant = await db.query(
        'SELECT * FROM merchants WHERE id = $1',
        [merchantId]
    );

    if (!merchant.rows[0]) {
        throw new Error('Merchant not found');
    }

    // Check if token needs refresh (within 1 hour of expiry)
    const expiresAt = new Date(merchant.rows[0].square_token_expires_at);
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

    let accessToken;
    if (expiresAt < oneHourFromNow) {
        accessToken = await refreshMerchantToken(merchantId);
    } else {
        accessToken = decryptToken(merchant.rows[0].square_access_token);
    }

    return new Client({
        environment: process.env.SQUARE_ENVIRONMENT === 'production'
            ? Environment.Production
            : Environment.Sandbox,
        accessToken: accessToken
    });
}

module.exports = {
    loadMerchantContext,
    requireMerchant,
    getSquareClientForMerchant
};
```

### 5.2 Database Query Wrapper

**New file: `utils/merchant-db.js`**
```javascript
const db = require('./database');

/**
 * Database wrapper that automatically adds merchant_id filtering
 */
class MerchantDB {
    constructor(merchantId) {
        if (!merchantId) {
            throw new Error('MerchantDB requires merchantId');
        }
        this.merchantId = merchantId;
    }

    /**
     * Query with automatic merchant_id parameter appended
     * Use $merchant_id placeholder in query
     */
    async query(text, params = []) {
        // Replace $merchant_id with the actual parameter position
        const merchantParamIndex = params.length + 1;
        const modifiedText = text.replace(/\$merchant_id/g, `$${merchantParamIndex}`);
        const modifiedParams = [...params, this.merchantId];

        return db.query(modifiedText, modifiedParams);
    }

    /**
     * Get items for this merchant
     */
    async getItems(options = {}) {
        const { includeDeleted = false, categoryId, search, limit = 1000 } = options;

        let query = `
            SELECT i.*, c.name as category_name
            FROM items i
            LEFT JOIN categories c ON c.id = i.category_id AND c.merchant_id = $merchant_id
            WHERE i.merchant_id = $merchant_id
        `;
        const params = [];

        if (!includeDeleted) {
            query += ` AND i.is_deleted = false`;
        }

        if (categoryId) {
            params.push(categoryId);
            query += ` AND i.category_id = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            query += ` AND (i.name ILIKE $${params.length} OR i.description ILIKE $${params.length})`;
        }

        query += ` ORDER BY i.name LIMIT ${limit}`;

        return this.query(query, params);
    }

    /**
     * Get variations for this merchant
     */
    async getVariations(options = {}) {
        const { itemId, withCosts = false, locationId } = options;

        let query = `
            SELECT v.*, i.name as item_name, i.category_id
            FROM variations v
            JOIN items i ON i.id = v.item_id AND i.merchant_id = $merchant_id
            WHERE v.merchant_id = $merchant_id
        `;
        const params = [];

        if (itemId) {
            params.push(itemId);
            query += ` AND v.item_id = $${params.length}`;
        }

        return this.query(query, params);
    }

    /**
     * Get inventory counts for this merchant
     */
    async getInventory(locationId) {
        const query = `
            SELECT
                ic.*,
                v.name as variation_name,
                v.sku,
                i.name as item_name
            FROM inventory_counts ic
            JOIN variations v ON v.square_variation_id = ic.catalog_object_id AND v.merchant_id = $merchant_id
            JOIN items i ON i.id = v.item_id AND i.merchant_id = $merchant_id
            WHERE ic.merchant_id = $merchant_id
                AND ic.location_id = $1
        `;

        return this.query(query, [locationId]);
    }

    /**
     * Create a new record with merchant_id automatically set
     */
    async insert(table, data) {
        const dataWithMerchant = { ...data, merchant_id: this.merchantId };
        const columns = Object.keys(dataWithMerchant);
        const values = Object.values(dataWithMerchant);
        const placeholders = columns.map((_, i) => `$${i + 1}`);

        const query = `
            INSERT INTO ${table} (${columns.join(', ')})
            VALUES (${placeholders.join(', ')})
            RETURNING *
        `;

        return db.query(query, values);
    }

    /**
     * Update records with merchant_id filter
     */
    async update(table, id, data) {
        const columns = Object.keys(data);
        const values = Object.values(data);
        const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');

        const query = `
            UPDATE ${table}
            SET ${setClause}, updated_at = NOW()
            WHERE id = $${values.length + 1} AND merchant_id = $${values.length + 2}
            RETURNING *
        `;

        return db.query(query, [...values, id, this.merchantId]);
    }

    /**
     * Delete records with merchant_id filter
     */
    async delete(table, id) {
        const query = `
            DELETE FROM ${table}
            WHERE id = $1 AND merchant_id = $2
            RETURNING *
        `;

        return db.query(query, [id, this.merchantId]);
    }
}

module.exports = MerchantDB;
```

### 5.3 API Endpoint Updates

Every endpoint in `server.js` needs to be updated. Here's the pattern:

**Before (single-tenant):**
```javascript
app.get('/api/items', requireAuth, async (req, res) => {
    const result = await db.query(`
        SELECT * FROM items WHERE is_deleted = false
    `);
    res.json(result.rows);
});
```

**After (multi-tenant):**
```javascript
app.get('/api/items', requireAuth, requireMerchant, async (req, res) => {
    const merchantDb = new MerchantDB(req.merchantContext.id);
    const result = await merchantDb.getItems({ includeDeleted: false });
    res.json(result.rows);
});
```

### 5.4 Square API Updates

**Before (single token):**
```javascript
// utils/square-api.js
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const client = new Client({
    environment: Environment.Production,
    accessToken: ACCESS_TOKEN
});

async function syncCatalog() {
    const response = await client.catalogApi.listCatalog();
    // ...
}
```

**After (per-merchant token):**
```javascript
// utils/square-api.js
async function syncCatalog(merchantId) {
    const client = await getSquareClientForMerchant(merchantId);
    const response = await client.catalogApi.listCatalog();

    const merchantDb = new MerchantDB(merchantId);
    // All inserts/updates use merchantDb
    // ...
}
```

---

## 6. Phase 4: Frontend Updates

### 6.1 Merchant Selector Component

Add to all pages that need merchant context:

```html
<!-- Merchant selector in header -->
<div id="merchant-selector" class="merchant-selector">
    <select id="active-merchant" onchange="switchMerchant(this.value)">
        <!-- Populated dynamically -->
    </select>
    <button onclick="showConnectSquare()" class="btn-connect">
        + Connect Square Account
    </button>
</div>

<script>
async function loadMerchants() {
    const response = await fetch('/api/merchants');
    const { merchants, activeMerchantId } = await response.json();

    const selector = document.getElementById('active-merchant');
    selector.innerHTML = merchants.map(m =>
        `<option value="${m.id}" ${m.id === activeMerchantId ? 'selected' : ''}>
            ${m.business_name}
        </option>`
    ).join('');

    if (merchants.length === 0) {
        showConnectSquare();
    }
}

async function switchMerchant(merchantId) {
    await fetch('/api/merchants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantId })
    });
    window.location.reload();
}

function showConnectSquare() {
    window.location.href = '/api/square/oauth/connect?redirect=' +
        encodeURIComponent(window.location.pathname);
}

// Load on page init
document.addEventListener('DOMContentLoaded', loadMerchants);
</script>
```

### 6.2 New Merchant Management Page

**New file: `public/merchants.html`**
- View connected Square accounts
- Set primary account
- Invite team members
- Disconnect accounts
- View account status (trial, active, etc.)

### 6.3 Updated API Calls

All frontend API calls remain the same - the merchant context is handled server-side via session.

---

## 7. Phase 5: Security & Compliance

### 7.1 Security Requirements

| Requirement | Implementation |
|-------------|---------------|
| Token encryption at rest | AES-256-GCM encryption for all tokens |
| Token transmission | HTTPS only, secure cookies |
| Access control | Row-level filtering by merchant_id |
| Audit logging | Log all data access with merchant context |
| Session security | Secure, httpOnly, sameSite cookies |
| SQL injection | Parameterized queries (already in place) |
| XSS protection | Content Security Policy headers |
| CSRF protection | SameSite cookies + CSRF tokens |

### 7.2 Data Isolation Testing

```javascript
// Test: User A cannot access User B's data
describe('Multi-tenant isolation', () => {
    it('should not return data from other merchants', async () => {
        // Create two merchants with data
        const merchantA = await createMerchant('Merchant A');
        const merchantB = await createMerchant('Merchant B');

        // Create items for each
        await createItem(merchantA.id, 'Item A');
        await createItem(merchantB.id, 'Item B');

        // Login as user linked to Merchant A
        const userA = await loginAs(merchantA.userId);

        // Fetch items - should only see Merchant A's items
        const response = await userA.get('/api/items');

        expect(response.body).toHaveLength(1);
        expect(response.body[0].name).toBe('Item A');
    });

    it('should prevent cross-merchant data modification', async () => {
        const merchantA = await createMerchant('Merchant A');
        const merchantB = await createMerchant('Merchant B');

        const itemB = await createItem(merchantB.id, 'Item B');

        const userA = await loginAs(merchantA.userId);

        // Try to update Merchant B's item
        const response = await userA.patch(`/api/items/${itemB.id}`, {
            name: 'Hacked Item'
        });

        expect(response.status).toBe(404); // Should not find it
    });
});
```

### 7.3 Compliance Checklist

- [ ] GDPR: Data export capability per merchant
- [ ] GDPR: Data deletion capability per merchant
- [ ] SOC 2: Audit logging for all data access
- [ ] PCI: No credit card data stored (Square handles this)
- [ ] Privacy Policy: Updated for multi-tenant
- [ ] Terms of Service: Updated for marketplace

---

## 8. Phase 6: Square Marketplace Requirements

### 8.1 Square App Marketplace Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| OAuth 2.0 implementation | Planned | Phase 2 |
| Webhook handling | Exists | Needs merchant context |
| Idempotency keys | Exists | Already implemented |
| Rate limiting | Exists | Needs per-merchant limits |
| Error handling | Exists | Needs better user messaging |
| Terms of Service | Needed | Legal review |
| Privacy Policy | Needed | Legal review |
| App icon/branding | Needed | Design team |
| App description | Needed | Marketing copy |
| Support email | Needed | support@yourdomain.com |
| Sandbox testing | Needed | Full test suite |

### 8.2 Webhook Updates

```javascript
// Current webhook handler needs merchant context
app.post('/api/webhooks/square', async (req, res) => {
    const signature = req.headers['x-square-signature'];
    const body = JSON.stringify(req.body);

    // Verify signature
    if (!verifyWebhookSignature(signature, body)) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const { merchant_id, type, data } = req.body;

    // Find our merchant by Square's merchant ID
    const merchant = await db.query(
        'SELECT id FROM merchants WHERE square_merchant_id = $1',
        [merchant_id]
    );

    if (!merchant.rows[0]) {
        console.log('Webhook for unknown merchant:', merchant_id);
        return res.status(200).json({ received: true });
    }

    const merchantId = merchant.rows[0].id;
    const merchantDb = new MerchantDB(merchantId);

    switch (type) {
        case 'catalog.version.updated':
            await syncCatalogForMerchant(merchantId);
            break;
        case 'inventory.count.updated':
            await handleInventoryUpdate(merchantDb, data);
            break;
        // ... other cases
    }

    res.status(200).json({ received: true });
});
```

### 8.3 Required OAuth Scopes

| Scope | Purpose | Required |
|-------|---------|----------|
| `MERCHANT_PROFILE_READ` | Get business name/info | Yes |
| `ITEMS_READ` | Read catalog | Yes |
| `ITEMS_WRITE` | Custom attributes | Yes |
| `INVENTORY_READ` | Stock levels | Yes |
| `INVENTORY_WRITE` | Update counts | Yes |
| `ORDERS_READ` | Sales velocity | Yes |
| `EMPLOYEES_READ` | (Future) Team access | Optional |

---

## 9. Migration Strategy

### 9.1 Migration Steps

1. **Create migration script** to add schema changes
2. **Create default merchant** for existing data
3. **Backfill merchant_id** on all existing records
4. **Update API endpoints** incrementally
5. **Deploy with feature flag** for gradual rollout
6. **Monitor and validate** data isolation

### 9.2 Migration Script

```sql
-- Migration: 005_multi_tenant.sql

BEGIN;

-- 1. Create new tables (see Phase 1 SQL above)
-- ... CREATE TABLE merchants ...
-- ... CREATE TABLE user_merchants ...

-- 2. Create default merchant for existing data
INSERT INTO merchants (
    square_merchant_id,
    business_name,
    square_access_token,
    subscription_status
) VALUES (
    'legacy_single_tenant',
    'Default Merchant (Migrated)',
    -- Move existing token to DB (encrypt first!)
    'ENCRYPTED_TOKEN_HERE',
    'active'
) RETURNING id;

-- 3. Link all existing users to default merchant
INSERT INTO user_merchants (user_id, merchant_id, role, is_primary, accepted_at)
SELECT id, 1, 'owner', true, NOW()
FROM users;

-- 4. Add merchant_id columns
ALTER TABLE items ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
-- ... repeat for all tables

-- 5. Backfill merchant_id
UPDATE items SET merchant_id = 1 WHERE merchant_id IS NULL;
UPDATE variations SET merchant_id = 1 WHERE merchant_id IS NULL;
UPDATE categories SET merchant_id = 1 WHERE merchant_id IS NULL;
-- ... repeat for all tables

-- 6. Add NOT NULL constraints after backfill
ALTER TABLE items ALTER COLUMN merchant_id SET NOT NULL;
ALTER TABLE variations ALTER COLUMN merchant_id SET NOT NULL;
-- ... repeat for all tables

-- 7. Create indexes (see Phase 1 SQL above)

COMMIT;
```

### 9.3 Rollback Plan

```sql
-- Rollback: In case of issues
BEGIN;

-- 1. Remove merchant_id columns
ALTER TABLE items DROP COLUMN merchant_id;
-- ... repeat for all tables

-- 2. Drop new tables
DROP TABLE IF EXISTS merchant_invitations;
DROP TABLE IF EXISTS user_merchants;
DROP TABLE IF EXISTS oauth_states;
DROP TABLE IF EXISTS merchants;

COMMIT;
```

---

## 10. Testing Strategy

### 10.1 Test Categories

| Category | Tests | Priority |
|----------|-------|----------|
| Unit tests | Token encryption/decryption | High |
| Unit tests | MerchantDB query building | High |
| Integration | OAuth flow end-to-end | Critical |
| Integration | Data isolation | Critical |
| Integration | Webhook processing | High |
| E2E | Multi-merchant switching | High |
| Performance | Queries with merchant_id | Medium |
| Security | Cross-tenant access attempts | Critical |

### 10.2 Test Data Setup

```javascript
// tests/fixtures/merchants.js
const testMerchants = [
    {
        squareMerchantId: 'test_merchant_1',
        businessName: 'Test Coffee Shop',
        accessToken: 'test_token_1'
    },
    {
        squareMerchantId: 'test_merchant_2',
        businessName: 'Test Bakery',
        accessToken: 'test_token_2'
    }
];
```

---

## 11. Implementation Checklist

### Phase 1: Database Schema (BLOCKING - Do First)

**Prerequisites:**
- [ ] Production database backup created and verified
- [ ] Staging environment has recent data copy
- [ ] Maintenance window communicated

**Migration File Creation:**
- [ ] Create `database/migrations/005_multi_tenant.sql`
- [ ] Create `database/migrations/005_multi_tenant_rollback.sql`

**New Tables:**
- [ ] `merchants` table with all columns (see Section 3.1)
- [ ] `user_merchants` table for user-merchant relationships
- [ ] `merchant_invitations` table for team invites
- [ ] `oauth_states` table for OAuth security

**Schema Modifications (each table):**
- [ ] `locations` - add merchant_id + index
- [ ] `categories` - add merchant_id + index
- [ ] `items` - add merchant_id + index + composite index
- [ ] `variations` - add merchant_id + index + composite index
- [ ] `images` - add merchant_id + index
- [ ] `inventory_counts` - add merchant_id + index + composite index
- [ ] `vendors` - add merchant_id + index
- [ ] `variation_vendors` - add merchant_id + index
- [ ] `vendor_catalog_items` - add merchant_id + index
- [ ] `purchase_orders` - add merchant_id + index + composite index
- [ ] `purchase_order_items` - add merchant_id + index
- [ ] `sales_velocity` - add merchant_id + index + composite index
- [ ] `variation_location_settings` - add merchant_id + index
- [ ] `count_history` - add merchant_id + index
- [ ] `count_queue_priority` - add merchant_id + index
- [ ] `count_queue_daily` - add merchant_id + index
- [ ] `count_sessions` - add merchant_id + index
- [ ] `variation_expiration` - add merchant_id + index
- [ ] `expiry_discount_tiers` - add merchant_id + index
- [ ] `variation_discount_status` - add merchant_id + index
- [ ] `expiry_discount_audit_log` - add merchant_id + index
- [ ] `expiry_discount_settings` - add merchant_id + index
- [ ] `brands` - add merchant_id + index
- [ ] `category_taxonomy_mapping` - add merchant_id + index
- [ ] `item_brands` - add merchant_id + index
- [ ] `gmc_settings` - add merchant_id + index
- [ ] `gmc_feed_history` - add merchant_id + index
- [ ] `sync_history` - add merchant_id + index

**Data Migration:**
- [ ] Create legacy merchant record for existing data
- [ ] Backfill merchant_id on ALL tables (verify 0 NULLs)
- [ ] Add NOT NULL constraints AFTER backfill
- [ ] Link existing users to legacy merchant

**Validation:**
- [ ] Run validation query (all merchant_id NOT NULL)
- [ ] Test rollback script works
- [ ] Verify foreign key constraints

### Phase 2: Token Security & OAuth

**Environment Setup:**
- [ ] Generate TOKEN_ENCRYPTION_KEY: `openssl rand -hex 32`
- [ ] Store key in password manager
- [ ] Add key to production .env
- [ ] Add SQUARE_APPLICATION_SECRET to .env

**Token Encryption (`utils/token-encryption.js`):**
- [ ] Create file with encryptToken() function
- [ ] Create file with decryptToken() function
- [ ] Test encryption roundtrip
- [ ] Test with actual Square token format

**Square Developer Dashboard:**
- [ ] OAuth application created
- [ ] Redirect URI configured
- [ ] Scopes selected (MERCHANT_PROFILE_READ, ITEMS_READ/WRITE, INVENTORY_READ/WRITE, ORDERS_READ)
- [ ] Sandbox credentials noted for testing

**OAuth Routes (`routes/square-oauth.js`):**
- [ ] GET /connect - Initiate OAuth, generate state
- [ ] GET /callback - Handle callback, exchange code for tokens
- [ ] POST /revoke - Disconnect merchant account
- [ ] Token refresh helper function
- [ ] Error handling for all failure scenarios

**Integration:**
- [ ] Register routes in server.js
- [ ] Test OAuth flow in sandbox
- [ ] Test with production Square account
- [ ] Verify tokens stored encrypted

### Phase 3: Merchant Context Middleware

**Middleware (`middleware/merchant.js`):**
- [ ] loadMerchantContext() - Load from session
- [ ] requireMerchant() - Enforce merchant exists
- [ ] getSquareClientForMerchant() - Get authenticated client
- [ ] Handle token refresh automatically
- [ ] Handle revoked tokens gracefully

**Database Wrapper (`utils/merchant-db.js`):**
- [ ] MerchantDB class constructor with merchantId
- [ ] query() method with $merchant_id placeholder
- [ ] insert() method with automatic merchant_id
- [ ] update() method with merchant_id filter
- [ ] delete() method with merchant_id filter
- [ ] Unit tests for all methods

**Registration:**
- [ ] Add middleware to server.js (after auth, before routes)
- [ ] Test with mock requests
- [ ] Verify session contains merchant context

### Phase 4: API Endpoint Updates (111 endpoints)

**Priority Group 1 - Dashboard Critical:**
- [ ] GET /api/sync/status
- [ ] GET /api/locations
- [ ] POST /api/sync/full
- [ ] GET /api/settings

**Priority Group 2 - Catalog:**
- [ ] GET /api/catalog
- [ ] GET /api/items
- [ ] GET /api/items/:id
- [ ] GET /api/variations
- [ ] GET /api/categories

**Priority Group 3 - Inventory:**
- [ ] GET /api/inventory
- [ ] POST /api/inventory/update
- [ ] GET /api/inventory/counts

**Priority Group 4 - Features:**
- [ ] All vendor endpoints (11)
- [ ] All purchase order endpoints (9)
- [ ] All expiry endpoints (14)
- [ ] All GMC endpoints (20)
- [ ] All cycle count endpoints (8)

**For EACH endpoint:**
- [ ] Add requireMerchant middleware
- [ ] Use MerchantDB or add merchant_id to queries
- [ ] Test with Merchant A context
- [ ] Test with Merchant B context
- [ ] Verify cross-merchant access blocked

### Phase 5: Frontend Updates

**Dashboard Updates (`dashboard.html`):**
- [ ] Add merchant name to header
- [ ] Add "Connect Square" button (if no merchant)
- [ ] Show "Connected to: [Business Name]"
- [ ] Handle no-merchant state gracefully

**New Page (`merchants.html`):**
- [ ] List connected Square accounts
- [ ] Show connection status for each
- [ ] Allow disconnect
- [ ] Link to connect new account

**All Authenticated Pages:**
- [ ] Add shared merchant header component
- [ ] Show active merchant name
- [ ] Handle API 403 (no merchant) errors

### Phase 6: Testing & Security

**Data Isolation Tests:**
- [ ] Create test: User A can't see User B's items
- [ ] Create test: User A can't update User B's data
- [ ] Create test: URL manipulation blocked
- [ ] Create test: Bulk operations validate ownership

**OAuth Flow Tests:**
- [ ] Test: Fresh OAuth connection
- [ ] Test: Token refresh before expiry
- [ ] Test: Token refresh after expiry
- [ ] Test: Revoked token handling
- [ ] Test: OAuth cancellation by user

**Security Review:**
- [ ] No tokens in logs
- [ ] No tokens in error messages
- [ ] All queries use merchant_id
- [ ] HTTPS enforced
- [ ] Session security verified

### Phase 7: Trial Launch Prep

**Final Checklist:**
- [ ] All Phase 1-6 items complete
- [ ] Production environment variables set
- [ ] Database migration run in production
- [ ] OAuth works in production
- [ ] Test users can complete onboarding

**Monitoring:**
- [ ] Error tracking active
- [ ] Database performance baseline established
- [ ] Alerts configured for critical errors

**Documentation:**
- [ ] User onboarding guide created
- [ ] Support email ready
- [ ] Known limitations documented

---

## Appendix A: File Creation & Modification Summary

### New Files to Create (in order)

| # | File | Purpose | Lines Est. | Blocking |
|---|------|---------|------------|----------|
| 1 | `database/migrations/005_multi_tenant.sql` | Schema migration | ~300 | Phase 1 |
| 2 | `database/migrations/005_multi_tenant_rollback.sql` | Rollback script | ~50 | Phase 1 |
| 3 | `utils/token-encryption.js` | Token encrypt/decrypt | ~50 | Phase 2 |
| 4 | `routes/square-oauth.js` | OAuth endpoints | ~200 | Phase 2 |
| 5 | `middleware/merchant.js` | Merchant context | ~150 | Phase 3 |
| 6 | `utils/merchant-db.js` | DB wrapper | ~200 | Phase 3 |
| 7 | `public/merchants.html` | Merchant management | ~400 | Phase 5 |

### Existing Files to Modify

| File | Changes | Impact | Phase |
|------|---------|--------|-------|
| `server.js` | Add 111 merchant_id filters | Critical | 3-4 |
| `server.js` | Register OAuth routes | Medium | 2 |
| `server.js` | Register merchant middleware | Medium | 3 |
| `middleware/auth.js` | Call loadMerchantContext | Low | 3 |
| `routes/auth.js` | Link user to merchant on login | Medium | 3 |
| `public/dashboard.html` | Merchant name, connect button | Low | 5 |
| `public/*.html` (18 files) | Handle no-merchant state | Low | 5 |
| `.env.example` | Add new env vars | Low | 2 |

### SQL Tables to Create

| Table | Purpose | Foreign Keys |
|-------|---------|--------------|
| `merchants` | Tenant storage, tokens | None |
| `user_merchants` | User-tenant link | users, merchants |
| `merchant_invitations` | Team invites | merchants, users |
| `oauth_states` | OAuth security | users |

### Columns to Add (27 tables)

All tables below need: `merchant_id INTEGER REFERENCES merchants(id)` + index

**Catalog (6):** locations, categories, items, variations, images, inventory_counts

**Vendors (3):** vendors, variation_vendors, vendor_catalog_items

**Purchase Orders (2):** purchase_orders, purchase_order_items

**Sales (2):** sales_velocity, variation_location_settings

**Cycle Count (4):** count_history, count_queue_priority, count_queue_daily, count_sessions

**Expiry (5):** variation_expiration, expiry_discount_tiers, variation_discount_status, expiry_discount_audit_log, expiry_discount_settings

**GMC (5):** brands, category_taxonomy_mapping, item_brands, gmc_settings, gmc_feed_history

**System (1):** sync_history

---

## Appendix B: Environment Variables

Add these new environment variables:

```env
# Square OAuth (Marketplace)
SQUARE_APPLICATION_ID=sq0idp-xxxxx
SQUARE_APPLICATION_SECRET=sq0csp-xxxxx
SQUARE_OAUTH_REDIRECT_URI=https://yourdomain.com/api/square/oauth/callback

# Token Security
TOKEN_ENCRYPTION_KEY=your-32-byte-hex-key-for-aes-256

# Feature Flags
ENABLE_MULTI_TENANT=true
LEGACY_SINGLE_TENANT_MODE=false
```

---

## Appendix C: API Changes Summary

**New Endpoints:**
- `GET /api/square/oauth/connect` - Start OAuth flow
- `GET /api/square/oauth/callback` - OAuth callback
- `POST /api/square/oauth/revoke` - Disconnect account
- `GET /api/merchants` - List user's merchants
- `POST /api/merchants/switch` - Switch active merchant
- `GET /api/merchants/:id` - Get merchant details
- `POST /api/merchants/:id/invite` - Invite team member
- `DELETE /api/merchants/:id` - Disconnect merchant

**Modified Endpoints (all 124):**
- All endpoints now require merchant context
- All queries filter by merchant_id
- All creates/updates set merchant_id

---

## 12. Error-Prone Areas & Safeguards

### 12.1 Critical Failure Points

#### ⚠️ DATABASE MIGRATION FAILURES

**Risk:** Migration fails midway, leaving database in inconsistent state.

**Safeguards:**
1. **ALWAYS run in a transaction** - The entire migration wrapped in `BEGIN;` / `COMMIT;`
2. **Test on a copy first** - Create database backup before running on production
3. **Run migration during low-traffic hours**
4. **Have rollback script ready and tested**

**Pre-migration checklist:**
```bash
# Create backup BEFORE migration
pg_dump -U $DB_USER -h $DB_HOST $DB_NAME > backup_pre_migration_$(date +%Y%m%d_%H%M%S).sql

# Verify backup is valid
psql -U $DB_USER -h $DB_HOST -d template1 -c "SELECT pg_size_pretty(pg_database_size('$DB_NAME'));"
```

#### ⚠️ MERCHANT_ID NOT NULL CONSTRAINT FAILURE

**Risk:** Adding `NOT NULL` constraint before backfilling merchant_id causes immediate failure.

**Correct Order:**
1. Add column **WITHOUT** NOT NULL
2. Backfill ALL existing data with default merchant_id
3. VERIFY count matches: `SELECT COUNT(*) FROM table WHERE merchant_id IS NULL` should = 0
4. THEN add NOT NULL constraint

**Safeguard Query:**
```sql
-- Run BEFORE adding NOT NULL - must return 0 for all tables
SELECT 'items' as table_name, COUNT(*) as null_count FROM items WHERE merchant_id IS NULL
UNION ALL
SELECT 'variations', COUNT(*) FROM variations WHERE merchant_id IS NULL
UNION ALL
SELECT 'categories', COUNT(*) FROM categories WHERE merchant_id IS NULL
-- ... repeat for all 25+ tables
;
```

#### ⚠️ FOREIGN KEY CONSTRAINT FAILURES

**Risk:** Creating merchant_id foreign key on existing data fails if merchants table doesn't have the referenced ID.

**Correct Order:**
1. Create merchants table FIRST
2. Insert the "legacy" merchant record and note its ID
3. THEN add merchant_id columns to other tables
4. Backfill using the correct legacy merchant ID
5. THEN add foreign key constraints

**Safeguard:** Always use the RETURNING clause to capture the merchant ID:
```sql
INSERT INTO merchants (...) VALUES (...) RETURNING id;
-- Use that exact ID in all UPDATE statements
```

#### ⚠️ TOKEN ENCRYPTION KEY ISSUES

**Risk:** Losing or changing encryption key makes all stored tokens unreadable.

**Safeguards:**
1. **Generate key properly:**
   ```bash
   # Generate 32-byte (256-bit) key as hex
   openssl rand -hex 32
   ```
2. **Store key in MULTIPLE secure locations:**
   - Production .env file
   - Password manager (1Password, LastPass, etc.)
   - Secure offline backup
3. **NEVER commit key to git**
4. **NEVER change key after tokens are encrypted** - requires re-encryption of all tokens

#### ⚠️ OAUTH STATE PARAMETER ISSUES

**Risk:** State validation fails, leaving users unable to complete OAuth flow.

**Common Causes:**
1. State expires before user completes Square authorization (10 min default)
2. User opens multiple OAuth tabs, invalidating earlier states
3. State stored in session that expires before callback

**Safeguards:**
1. Set reasonable expiry (10-15 minutes)
2. Clear error messaging: "Your connection request expired. Please try again."
3. Log state validation failures for debugging
4. Allow state re-use within expiry window (don't mark used until success)

#### ⚠️ MISSING MERCHANT CONTEXT ON API CALLS

**Risk:** API returns 403 "No merchant connected" when user expects data.

**Safeguards:**
1. Dashboard should check merchant connection on load
2. Show clear CTA: "Connect your Square account to get started"
3. After OAuth success, redirect to meaningful page (not blank dashboard)
4. Include merchant name in UI header so users know which account is active

### 12.2 Data Isolation Failure Scenarios

#### SCENARIO: Cross-Merchant Data Leak via Direct URL

**Attack:** User A copies URL with item_id from their dashboard, shares with User B. User B accesses the URL.

**Defense:** ALL endpoints must verify `merchant_id` matches before returning data:
```javascript
// WRONG - only checks if item exists
const item = await db.query('SELECT * FROM items WHERE id = $1', [itemId]);

// RIGHT - checks item belongs to merchant
const item = await db.query(
    'SELECT * FROM items WHERE id = $1 AND merchant_id = $2',
    [itemId, req.merchantContext.id]
);
```

#### SCENARIO: Bulk Update Hits Wrong Merchant's Data

**Attack:** Malformed request body contains IDs from different merchant.

**Defense:** All bulk operations must validate each ID belongs to current merchant:
```javascript
// Validate ALL IDs before any updates
const validIds = await db.query(
    'SELECT id FROM items WHERE id = ANY($1) AND merchant_id = $2',
    [requestedIds, merchantId]
);

if (validIds.rows.length !== requestedIds.length) {
    return res.status(403).json({ error: 'Access denied to one or more items' });
}
```

#### SCENARIO: Webhook Processes Data for Wrong Merchant

**Attack:** Malicious webhook payload contains different merchant_id.

**Defense:** ALWAYS look up merchant by Square's merchant_id from webhook, never trust request body:
```javascript
// Extract merchant from webhook payload's merchant_id field
const squareMerchantId = req.body.merchant_id;
const merchant = await db.query(
    'SELECT id FROM merchants WHERE square_merchant_id = $1',
    [squareMerchantId]
);
// Use merchant.id for all operations
```

### 12.3 Token Security Failure Scenarios

#### SCENARIO: Token Refresh Race Condition

**Risk:** Two requests try to refresh token simultaneously, one fails with invalid refresh token.

**Defense:** Implement token refresh locking:
```javascript
// Use database advisory lock or Redis lock
const lockKey = `token_refresh_${merchantId}`;
if (await acquireLock(lockKey, 30000)) {
    try {
        // Check if token was already refreshed by another request
        const merchant = await getMerchant(merchantId);
        if (new Date(merchant.token_expires_at) > new Date(Date.now() + 60000)) {
            // Token was refreshed by another request, use it
            return decryptToken(merchant.square_access_token);
        }
        // Proceed with refresh
        await refreshToken(merchantId);
    } finally {
        await releaseLock(lockKey);
    }
}
```

#### SCENARIO: Revoked Token Not Detected

**Risk:** Square revokes access but app continues trying to use token.

**Defense:**
1. Handle 401 responses from Square API gracefully
2. Mark merchant as needing re-authorization
3. Show user-friendly message: "Please reconnect your Square account"
4. Process `oauth.authorization.revoked` webhooks

---

## 13. Pre-Flight Checklists

### 13.1 Before Starting Phase 1 (Database)

```markdown
## Database Migration Pre-Flight

### Environment
- [ ] Database backup completed and verified
- [ ] Backup file size matches expected (~X MB)
- [ ] Test restore of backup works on staging
- [ ] Database connection pooling configured (max connections)
- [ ] Maintenance window scheduled with team

### Code Ready
- [ ] Migration file created: `database/migrations/005_multi_tenant.sql`
- [ ] Rollback file created: `database/migrations/005_multi_tenant_rollback.sql`
- [ ] Tested migration on local database copy
- [ ] Tested rollback on local database copy

### Validation Queries Ready
- [ ] Query to verify all tables have merchant_id
- [ ] Query to verify no NULL merchant_ids remain
- [ ] Query to verify foreign key constraints are valid
- [ ] Query to count records per table before/after

### Go/No-Go
- [ ] Team notified of maintenance window
- [ ] Rollback trigger defined (what failure = rollback?)
- [ ] On-call person identified for issues
```

### 13.2 Before Starting Phase 2 (OAuth)

```markdown
## OAuth Implementation Pre-Flight

### Square Developer Setup
- [ ] Square Developer account active
- [ ] OAuth application created at https://developer.squareup.com/apps
- [ ] Application ID saved to .env
- [ ] Application Secret saved to .env (NEVER commit)
- [ ] OAuth Redirect URI configured in Square dashboard
- [ ] OAuth Redirect URI matches .env exactly
- [ ] Required scopes selected:
    - [ ] MERCHANT_PROFILE_READ
    - [ ] ITEMS_READ
    - [ ] ITEMS_WRITE
    - [ ] INVENTORY_READ
    - [ ] INVENTORY_WRITE
    - [ ] ORDERS_READ

### Token Security
- [ ] TOKEN_ENCRYPTION_KEY generated: `openssl rand -hex 32`
- [ ] Key backed up in secure location (not git)
- [ ] Key added to production .env
- [ ] Encryption/decryption tested locally

### Code Ready
- [ ] `routes/square-oauth.js` created
- [ ] `utils/token-encryption.js` created
- [ ] OAuth routes registered in server.js
- [ ] Error handling for OAuth failures implemented

### Testing Plan
- [ ] Square Sandbox account ready for testing
- [ ] Test OAuth flow end-to-end in sandbox
- [ ] Test token refresh mechanism
- [ ] Test token revocation handling
```

### 13.3 Before Starting Phase 3 (API Layer)

```markdown
## API Layer Update Pre-Flight

### Middleware Ready
- [ ] `middleware/merchant.js` created with:
    - [ ] loadMerchantContext()
    - [ ] requireMerchant()
    - [ ] getSquareClientForMerchant()
- [ ] Middleware registered in correct order in server.js
- [ ] Tested middleware with mock requests

### Database Wrapper Ready
- [ ] `utils/merchant-db.js` created
- [ ] MerchantDB class implements:
    - [ ] query() with $merchant_id placeholder
    - [ ] insert() with automatic merchant_id
    - [ ] update() with merchant_id filter
    - [ ] delete() with merchant_id filter
- [ ] Unit tests pass for MerchantDB

### Endpoint Update Strategy
- [ ] Endpoints grouped by priority (critical first)
- [ ] Each endpoint update follows pattern:
    1. Add requireMerchant middleware
    2. Replace db.query with merchantDb.query
    3. Verify WHERE clauses include merchant_id
    4. Test with multiple merchant contexts

### Testing Ready
- [ ] Two test merchants created in database
- [ ] Test data seeded for both merchants
- [ ] Integration tests written for isolation
- [ ] Cross-merchant access tests defined
```

### 13.4 Before Each Deployment

```markdown
## Deployment Checklist

### Code Review
- [ ] All changes reviewed by second person
- [ ] No console.log statements with sensitive data
- [ ] No hardcoded credentials or tokens
- [ ] Error handling covers edge cases

### Environment
- [ ] All required env variables set in production
- [ ] Database migrations run successfully
- [ ] No breaking schema changes without migration

### Testing
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed for changed features
- [ ] Cross-browser testing (if frontend changes)

### Rollback Plan
- [ ] Previous working version identified
- [ ] Rollback command documented
- [ ] Database rollback script ready (if schema changes)

### Monitoring
- [ ] Error tracking active (Sentry, etc.)
- [ ] Log aggregation working
- [ ] Alerts configured for critical failures
```

---

## 14. Trial Launch Readiness

### 14.1 Minimum Viable Multi-Tenant (MVMT)

For trial launch with test users, these features are **REQUIRED**:

| Feature | Required | Nice-to-Have |
|---------|----------|--------------|
| User can create account | ✅ DONE | - |
| User can login/logout | ✅ DONE | - |
| User can connect Square account (OAuth) | **REQUIRED** | - |
| User sees only their data | **REQUIRED** | - |
| Token encryption at rest | **REQUIRED** | - |
| Token auto-refresh | **REQUIRED** | - |
| Merchant switching (multi-account) | - | ✅ Phase 2 |
| Team member invitations | - | ✅ Future |
| Subscription billing | ✅ EXISTS | Needs merchant link |

### 14.2 Trial User Onboarding Flow

```
1. User visits landing page (/)
   └── Clicks "Get Started" or "Start Free Trial"

2. User creates account (/subscribe.html or /signup.html)
   └── Email, password, basic info
   └── Trial period starts (14 days?)

3. User logs in → Dashboard (/dashboard.html)
   └── Dashboard shows "Connect Square Account" CTA
   └── No data visible until connected

4. User clicks "Connect Square Account"
   └── Redirects to Square OAuth
   └── User authorizes on Square.com
   └── Callback creates merchant record
   └── User returned to dashboard

5. Dashboard now shows tools
   └── Initial sync runs automatically
   └── User sees their Square data
   └── Full feature access during trial

6. Trial expiration handling
   └── Warning at 3 days remaining
   └── Read-only mode after expiration
   └── Convert to paid via /subscribe.html
```

### 14.3 Trial Launch Validation Tests

Run these tests with real test users before wider launch:

```markdown
## Test 1: Fresh User Onboarding
- [ ] Create new account
- [ ] Login works
- [ ] Dashboard shows connection prompt
- [ ] OAuth flow completes successfully
- [ ] Data syncs within 5 minutes
- [ ] All dashboard tools work

## Test 2: Data Isolation (CRITICAL)
- [ ] Create two test accounts
- [ ] Connect different Square sandbox accounts
- [ ] Verify User A cannot see User B's items
- [ ] Verify User A cannot see User B's vendors
- [ ] Verify User A cannot see User B's POs
- [ ] Try URL manipulation attacks

## Test 3: Session & Token Management
- [ ] Session persists across browser close
- [ ] Session expires after inactivity (configurable)
- [ ] Token refresh works (wait for expiry)
- [ ] Logout clears session completely
- [ ] Login on new device works

## Test 4: Error Handling
- [ ] Invalid credentials show clear error
- [ ] OAuth cancellation handled gracefully
- [ ] Square API errors don't crash app
- [ ] Network failures show retry option

## Test 5: Trial Period
- [ ] Trial end date calculated correctly
- [ ] Trial expiration warning displays
- [ ] Post-trial restrictions work
- [ ] Subscription upgrade works
```

### 14.4 Launch Day Checklist

```markdown
## 48 Hours Before
- [ ] Final code freeze
- [ ] All tests passing in staging
- [ ] Database backup verified
- [ ] Team availability confirmed

## 24 Hours Before
- [ ] Production environment variables verified
- [ ] SSL certificates valid
- [ ] DNS propagated (if new domain)
- [ ] Monitoring dashboards ready

## Launch Day
- [ ] Deploy to production
- [ ] Run smoke tests
- [ ] Verify OAuth flow works in production
- [ ] Send invites to first test users
- [ ] Monitor error logs closely

## Post-Launch (First 24 Hours)
- [ ] Respond to user issues within 1 hour
- [ ] Monitor database performance
- [ ] Check error rate < 1%
- [ ] Gather initial user feedback
```

### 14.5 Known Limitations for Trial

Be transparent with trial users about these limitations:

1. **Single Square Account:** Each user can connect one Square account initially
2. **Manual Sync:** Auto-sync may require manual trigger during trial
3. **Limited Support:** Email support only, 24-48 hour response time
4. **Data Retention:** Trial data may be deleted after 30 days of inactivity
5. **Feature Parity:** Some advanced features may be added post-trial

### 14.6 Success Metrics for Trial

Track these KPIs to determine trial success:

| Metric | Target | Measurement |
|--------|--------|-------------|
| Signup → OAuth Complete | > 70% | Users who connect Square account |
| OAuth → Data Sync | > 95% | Sync completes without errors |
| Day 1 → Day 7 Retention | > 50% | Users returning after first week |
| Trial → Paid Conversion | > 10% | Trial users becoming paying customers |
| Error Rate | < 1% | Server errors / total requests |
| Support Tickets | < 5 per user | Issues reported during trial |

---

## 15. Execution Sequence (Detailed)

### Step-by-Step Implementation Order

This section provides the EXACT sequence to execute for a successful transition:

### STEP 1: Database Migration (DO FIRST)

**Files to create:**
1. `database/migrations/005_multi_tenant.sql`

**Execution:**
```bash
# 1. Backup production database
pg_dump -Fc -U $PGUSER -h $PGHOST $PGDATABASE > backup_$(date +%Y%m%d).dump

# 2. Apply migration
psql -U $PGUSER -h $PGHOST -d $PGDATABASE -f database/migrations/005_multi_tenant.sql

# 3. Verify migration
psql -U $PGUSER -h $PGHOST -d $PGDATABASE -c "SELECT COUNT(*) FROM merchants;"
# Should return 1 (legacy merchant)

psql -U $PGUSER -h $PGHOST -d $PGDATABASE -c "SELECT COUNT(*) FROM items WHERE merchant_id IS NULL;"
# Should return 0
```

### STEP 2: Token Encryption Utility

**File to create:** `utils/token-encryption.js`

**Validation:**
```javascript
// Test encryption/decryption
const { encryptToken, decryptToken } = require('./utils/token-encryption');
const testToken = 'EAAAtest123';
const encrypted = encryptToken(testToken);
const decrypted = decryptToken(encrypted);
console.assert(decrypted === testToken, 'Encryption roundtrip failed');
```

### STEP 3: Square OAuth Routes

**File to create:** `routes/square-oauth.js`

**Register in server.js:**
```javascript
const squareOAuth = require('./routes/square-oauth');
app.use('/api/square/oauth', squareOAuth);
```

**Validation:**
1. Visit `/api/square/oauth/connect`
2. Should redirect to Square authorization page
3. Complete authorization
4. Should redirect back to dashboard
5. Check `merchants` table for new record

### STEP 4: Merchant Context Middleware

**File to create:** `middleware/merchant.js`

**Register in server.js (order matters!):**
```javascript
// AFTER auth middleware, BEFORE routes
app.use(loadMerchantContext);
```

### STEP 5: MerchantDB Wrapper

**File to create:** `utils/merchant-db.js`

### STEP 6: Update API Endpoints (Incremental)

**Priority order:**
1. Dashboard endpoints (`/api/sync/status`, `/api/locations`)
2. Catalog endpoints (`/api/catalog`, `/api/items`, `/api/variations`)
3. Inventory endpoints (`/api/inventory`)
4. Feature endpoints (vendors, POs, expiry, etc.)

**For each endpoint:**
1. Add `requireMerchant` middleware
2. Create `MerchantDB` instance
3. Update queries to use merchant filtering
4. Test with multiple merchant contexts

### STEP 7: Frontend Updates

**Add to all authenticated pages:**
1. Merchant selector (if supporting multiple)
2. Business name in header
3. "Connected to: [Business Name]" indicator

**Create new page:**
- `public/merchants.html` - Manage connected accounts

### STEP 8: Testing & Validation

1. Create 2 test merchant accounts
2. Seed different data for each
3. Run isolation tests
4. Run integration tests
5. Manual testing of all features

### STEP 9: Deploy to Production

1. Deploy code changes
2. Run database migration
3. Create legacy merchant for existing data
4. Verify existing users can still access data
5. Enable OAuth for new connections

---

*End of Multi-User Account Isolation Plan*
