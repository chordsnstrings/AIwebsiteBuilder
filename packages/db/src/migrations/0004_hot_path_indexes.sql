-- Hot-path indexes.
--
-- The gate's frequency-cap rule (rule 7) runs on EVERY outbound send and walks
-- contacts → leads → conversations → messages. Without an index on the two
-- middle join columns the planner cannot drive from the indexed
-- contacts.email_hash, so it starts with a sequential scan of `messages` —
-- which at ~3.2M sends/year makes the p99 <200ms gate SLO unreachable and gets
-- worse every day the system runs.

-- conversations.lead_id had no index at all.
CREATE INDEX IF NOT EXISTS conversations_lead ON conversations (lead_id);
CREATE INDEX IF NOT EXISTS conversations_customer ON conversations (customer_id);

-- leads.contact_id was only covered by a PARTIAL unique index (non-terminal
-- states), so terminal leads — the majority over time — were unindexed on the
-- very column the gate joins on.
CREATE INDEX IF NOT EXISTS leads_contact ON leads (contact_id);

-- The frequency-cap window filters outbound messages by time. A partial index
-- keeps it small: inbound mail is never counted against the cap.
CREATE INDEX IF NOT EXISTS messages_outbound_sent ON messages (sent_at DESC)
  WHERE direction = 'outbound';

-- gate_decisions is filtered by contact_hash for DSAR export and operator
-- search, and is a 7-year append-only table — it only ever grows.
CREATE INDEX IF NOT EXISTS gate_decisions_contact ON gate_decisions (contact_hash);

-- Suppression is checked by the gate before anything else. The unique partial
-- indexes already cover email_hash/phone_hash lookups, so nothing to add.

-- Sending-asset rotation picks the least-recently-used healthy asset in a pool.
CREATE INDEX IF NOT EXISTS sending_assets_pool_health ON sending_assets (pool, health);

-- Probe results and events are written constantly and read by vendor/time.
CREATE INDEX IF NOT EXISTS probe_results_recent ON probe_results (vendor_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS events_subject ON events (subject_kind, subject_id);

-- Previews are swept hourly for expiry.
CREATE INDEX IF NOT EXISTS previews_expiry_sweep ON previews (expires_at)
  WHERE takedown_at IS NULL AND claimed_at IS NULL;

-- Dunning sweeps due actions hourly.
CREATE INDEX IF NOT EXISTS dunning_due ON dunning_state (next_action_at)
  WHERE status = 'active';
