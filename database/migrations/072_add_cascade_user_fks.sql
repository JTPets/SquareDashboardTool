-- Migration 072: Add ON DELETE CASCADE to user_id foreign keys (DB-6)
-- Prevents orphan rows when users are deleted.
-- Affects 7 tables with REFERENCES users(id) missing ON DELETE CASCADE.

BEGIN;

-- 1. oauth_states.user_id
ALTER TABLE oauth_states
    DROP CONSTRAINT IF EXISTS oauth_states_user_id_fkey,
    ADD CONSTRAINT oauth_states_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 2. delivery_routes.generated_by
ALTER TABLE delivery_routes
    DROP CONSTRAINT IF EXISTS delivery_routes_generated_by_fkey,
    ADD CONSTRAINT delivery_routes_generated_by_fkey
        FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE CASCADE;

-- 3. delivery_audit_log.user_id
ALTER TABLE delivery_audit_log
    DROP CONSTRAINT IF EXISTS delivery_audit_log_user_id_fkey,
    ADD CONSTRAINT delivery_audit_log_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 4. loyalty_offers.created_by
ALTER TABLE loyalty_offers
    DROP CONSTRAINT IF EXISTS loyalty_offers_created_by_fkey,
    ADD CONSTRAINT loyalty_offers_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;

-- 5. loyalty_redemptions.redeemed_by_user_id
ALTER TABLE loyalty_redemptions
    DROP CONSTRAINT IF EXISTS loyalty_redemptions_redeemed_by_user_id_fkey,
    ADD CONSTRAINT loyalty_redemptions_redeemed_by_user_id_fkey
        FOREIGN KEY (redeemed_by_user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 6. loyalty_audit_logs.user_id
ALTER TABLE loyalty_audit_logs
    DROP CONSTRAINT IF EXISTS loyalty_audit_logs_user_id_fkey,
    ADD CONSTRAINT loyalty_audit_logs_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 7. delivery_route_tokens.created_by
-- NOTE: delivery_route_tokens may not exist in production if its CREATE TABLE
-- migration has not yet run. The CREATE TABLE in schema.sql already includes
-- ON DELETE CASCADE, so this is safe to skip when the table is absent.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'delivery_route_tokens') THEN
        ALTER TABLE delivery_route_tokens
            DROP CONSTRAINT IF EXISTS delivery_route_tokens_created_by_fkey;
        ALTER TABLE delivery_route_tokens
            ADD CONSTRAINT delivery_route_tokens_created_by_fkey
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

COMMIT;
