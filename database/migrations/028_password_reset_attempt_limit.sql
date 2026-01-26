-- Migration 028: Add attempt limiting to password reset tokens
-- Security fix for P1-7: Prevents brute-force attacks on reset tokens
--
-- After this migration, password reset tokens have a limited number of
-- validation attempts (default 5). Each failed password reset decrements
-- the counter. When attempts reach 0, the token is invalidated.

-- Add attempts_remaining column with default of 5
ALTER TABLE password_reset_tokens
ADD COLUMN IF NOT EXISTS attempts_remaining INTEGER DEFAULT 5 NOT NULL;

-- Add index for efficient queries on valid tokens
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_valid
ON password_reset_tokens (token, expires_at, used_at, attempts_remaining)
WHERE used_at IS NULL AND attempts_remaining > 0;

-- Update comment on table
COMMENT ON COLUMN password_reset_tokens.attempts_remaining IS
    'Number of password reset attempts remaining. Token invalidated when 0.';
