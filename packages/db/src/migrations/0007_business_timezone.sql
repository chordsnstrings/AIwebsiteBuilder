-- The recipient's timezone.
--
-- Quiet hours are a compliance rule evaluated in the RECIPIENT's local time, not
-- ours. Without a timezone on the business the only thing the send path could
-- pass to the gate was the UTC hour, which is wrong everywhere except Britain in
-- winter — sometimes in a way that denies a legitimate send, sometimes in a way
-- that would have mailed someone at 3am.
--
-- Nullable: a lead vendor that does not supply one falls back to the region's
-- representative zone, which is documented in the send activity.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS timezone TEXT;

GRANT SELECT, INSERT, UPDATE ON businesses TO adw_app;
