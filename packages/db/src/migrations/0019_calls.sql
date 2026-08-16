-- Telephony (catalogue MF11 — 3 units).
--
-- Three units, and the smallest family in the catalogue. The value is almost
-- entirely in one of them: a missed call at a trade business is a customer who
-- has already decided to buy and is now dialling the next number on the list.
--
-- ⛔ This records calls; it does not place them and it does not text anyone.
-- The spec keeps SMS and voice behind the consent bridge, and the bridge does
-- not exist. What this family does is turn a call that nobody answered into an
-- enquiry the owner can see — and, where a reply is warranted, ASK THE GATE,
-- which denies for want of a legal basis and records why. A denial recorded is
-- a system that will start working the day consent arrives; a send that skipped
-- the gate is a regulatory problem that starts the same day.

CREATE TABLE IF NOT EXISTS calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  -- 'missed' | 'answered' | 'voicemail'
  outcome       TEXT NOT NULL CHECK (outcome IN ('missed','answered','voicemail')),
  direction     TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  -- ⛔ Hashed, like every other identifier the gate reasons about. A phone
  -- number in cleartext in a table nobody thought of as personal data is how a
  -- DSAR export misses half its subject.
  caller_hash   BYTEA NOT NULL,
  -- Kept in the clear ONLY so the owner can return the call. It is the whole
  -- point of the record; without it a missed-call log is a counter.
  caller_number TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  duration_seconds INT,
  -- Voicemail or live transcription. Third-party text: treated as untrusted
  -- input wherever a model reads it.
  transcript    TEXT,
  recording_ref TEXT,
  enquiry_id    UUID REFERENCES enquiries(id),
  session_id    UUID REFERENCES agent_sessions(id),
  -- What we decided to do about it, and what the gate said.
  followed_up   BOOLEAN NOT NULL DEFAULT FALSE,
  gate_decision_id UUID,
  gate_reason   TEXT,
  provider      TEXT NOT NULL DEFAULT 'unknown',
  provider_call_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per call from a provider, so a redelivered webhook is the same call.
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX IF NOT EXISTS calls_customer ON calls (customer_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_missed
  ON calls (customer_id, started_at DESC) WHERE outcome = 'missed' AND followed_up = FALSE;
