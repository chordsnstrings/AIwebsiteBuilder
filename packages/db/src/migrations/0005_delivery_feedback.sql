-- Delivery feedback linkage.
--
-- The deliverability control loop reads messages.bounced_at / complained_at to
-- decide whether a sending asset stays healthy. Those columns existed from
-- 0001 but nothing could ever write them: a provider bounce notification
-- identifies the message by the provider's own message id, and we had no column
-- holding it. Without this join the loop reads zero complaints forever and can
-- never halt an asset — the failure mode is silent, which is the worst kind.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Provider ids are unique per provider; a duplicate here means a webhook was
-- replayed or two sends collided, both of which we want to notice.
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_message_id
  ON messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- The trailing-7-day sweep scans per asset over a time window.
CREATE INDEX IF NOT EXISTS messages_asset_window
  ON messages (sending_asset_id, sent_at DESC)
  WHERE sending_asset_id IS NOT NULL;

-- Unsubscribe and takedown routes look a contact up by id and then suppress by
-- its email_hash; the PK covers the first half, this covers reporting on the
-- second (how many suppressions came from which reason, over what window).
CREATE INDEX IF NOT EXISTS suppression_reason_time
  ON suppression (reason, suppressed_at DESC);

GRANT SELECT, INSERT, UPDATE ON messages TO adw_app;
