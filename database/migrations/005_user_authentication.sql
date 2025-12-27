-- Migration: 005_user_authentication.sql
-- Description: Add user authentication tables for multi-user support
-- Date: 2024-12-27

-- =====================================================
-- USERS TABLE
-- Stores user accounts with hashed passwords
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('admin', 'user', 'readonly')),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP WITH TIME ZONE,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster email lookups during login
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = true;

-- =====================================================
-- SESSIONS TABLE
-- Server-side session storage (used by connect-pg-simple)
-- =====================================================
CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(255) PRIMARY KEY NOT NULL,
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);

-- Index for session expiration cleanup
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

-- =====================================================
-- AUTH AUDIT LOG
-- Track login attempts and security events
-- =====================================================
CREATE TABLE IF NOT EXISTS auth_audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email VARCHAR(255),  -- Store email even if user doesn't exist (failed logins)
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'login_success',
        'login_failed',
        'logout',
        'password_change',
        'account_locked',
        'account_unlocked',
        'user_created',
        'user_updated',
        'user_deactivated'
    )),
    ip_address VARCHAR(45),  -- IPv6 can be up to 45 chars
    user_agent TEXT,
    details JSONB,  -- Additional event-specific data
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying audit logs
CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_email ON auth_audit_log(email);
CREATE INDEX IF NOT EXISTS idx_auth_audit_type ON auth_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);

-- =====================================================
-- FUNCTION: Update updated_at timestamp
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at on users table
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- COMMENTS
-- =====================================================
COMMENT ON TABLE users IS 'User accounts for authentication';
COMMENT ON COLUMN users.role IS 'User role: admin (full access), user (standard), readonly (view only)';
COMMENT ON COLUMN users.failed_login_attempts IS 'Counter for failed login attempts, reset on successful login';
COMMENT ON COLUMN users.locked_until IS 'Account locked until this time after too many failed attempts';

COMMENT ON TABLE sessions IS 'Server-side session storage for express-session';

COMMENT ON TABLE auth_audit_log IS 'Audit trail for authentication events';
