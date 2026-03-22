-- Migration 007: Staff accounts — roles on user_merchants + staff_invitations
-- BACKLOG-41: User access control with roles
BEGIN;

-- ============================================================
-- 1. Add role column to user_merchants (if not already present)
-- ============================================================
-- The schema-manager creates user_merchants with a 'role' column using
-- CHECK (role IN ('owner', 'admin', 'user', 'readonly')).
-- We ALTER the constraint to use the new staff role set and update defaults.

-- Drop old constraint if it exists
ALTER TABLE user_merchants DROP CONSTRAINT IF EXISTS valid_role;

-- Update the role column default and add new constraint
ALTER TABLE user_merchants
    ALTER COLUMN role SET DEFAULT 'user',
    ADD CONSTRAINT valid_role CHECK (role IN ('owner', 'manager', 'clerk', 'readonly', 'user'));

-- Migrate: set the first user per merchant as 'owner' (oldest user_merchants row)
UPDATE user_merchants
SET role = 'owner'
WHERE id IN (
    SELECT DISTINCT ON (merchant_id) id
    FROM user_merchants
    ORDER BY merchant_id, id ASC
)
AND role NOT IN ('owner');

-- ============================================================
-- 2. Create staff_invitations table
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_invitations (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    invited_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(merchant_id, email),
    CONSTRAINT valid_invitation_role CHECK (role IN ('manager', 'clerk', 'readonly'))
);

CREATE INDEX IF NOT EXISTS idx_staff_invitations_merchant
    ON staff_invitations(merchant_id);

CREATE INDEX IF NOT EXISTS idx_staff_invitations_token_hash
    ON staff_invitations(token_hash);

COMMIT;
