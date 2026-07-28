-- Conversation state for the booking and lead-capture machines.
--
-- The machines in @adw/concierge are pure reducers, which is what makes a
-- replayed turn safe: the same state and the same message produce the same next
-- state anywhere. That only holds if the state is DURABLE. The API is stateless
-- per request, so without a column here the state would have to be reconstructed
-- by re-parsing the transcript on every turn — and a reducer whose input is a
-- re-parse of its own past output is not a reducer, it is a guess that gets
-- worse the longer the conversation runs.
--
-- One JSONB, one row per session, overwritten in place. The transcript in
-- agent_turns remains the evidence; this is only where the machine is standing.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS machine_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The owner's gap list is read on every dashboard load, ordered by how often a
-- question was asked. Without this it is a sequential scan of every gap the
-- business has ever accumulated.
CREATE INDEX IF NOT EXISTS agent_gaps_owner_open
  ON agent_gaps (COALESCE(customer_id, business_id), times_asked DESC)
  WHERE status IN ('open', 'drafted');
