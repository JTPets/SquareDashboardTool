-- Migration 039: Add encrypted Claude API key storage to merchant_settings
-- Security: Store Claude API key server-side with AES-256-GCM encryption
-- instead of in browser localStorage

ALTER TABLE merchant_settings
ADD COLUMN IF NOT EXISTS claude_api_key_encrypted TEXT;

COMMENT ON COLUMN merchant_settings.claude_api_key_encrypted IS
    'AES-256-GCM encrypted Claude API key for AI autofill feature. Format: iv:authTag:ciphertext (hex)';
