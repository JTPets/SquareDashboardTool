-- Migration 071: Add BEFORE UPDATE trigger to enforce loyalty_rewards status transitions
--
-- LOGIC CHANGE (MED-5): Enforce the loyalty_rewards state machine at the DB level.
-- Valid transitions:
--   in_progress -> earned
--   earned      -> redeemed
--   earned      -> revoked
-- Terminal states (cannot transition out): redeemed, revoked
-- Non-status updates (e.g. updating current_quantity) are always allowed.
-- Invalid transitions raise an exception.

-- Create the trigger function
CREATE OR REPLACE FUNCTION enforce_loyalty_reward_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    -- Allow updates that do not change the status column
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    -- Validate allowed transitions
    IF OLD.status = 'in_progress' AND NEW.status = 'earned' THEN
        RETURN NEW;
    ELSIF OLD.status = 'earned' AND NEW.status = 'redeemed' THEN
        RETURN NEW;
    ELSIF OLD.status = 'earned' AND NEW.status = 'revoked' THEN
        RETURN NEW;
    END IF;

    -- All other transitions are invalid
    RAISE EXCEPTION 'Invalid loyalty_rewards status transition from % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS enforce_loyalty_reward_status ON loyalty_rewards;

-- Create the trigger
CREATE TRIGGER enforce_loyalty_reward_status
    BEFORE UPDATE ON loyalty_rewards
    FOR EACH ROW
    EXECUTE FUNCTION enforce_loyalty_reward_status_transition();

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Migration 071: loyalty_rewards status transition trigger created successfully';
    RAISE NOTICE 'Valid transitions: in_progress->earned, earned->redeemed, earned->revoked';
    RAISE NOTICE 'Terminal states: redeemed, revoked (cannot transition out)';
END $$;
