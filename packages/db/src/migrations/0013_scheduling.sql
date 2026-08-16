-- Capacity and scheduling (catalogue MF10 — 53 units).
--
-- `bookingNext` was written, unit-tested and reachable from POST /agent/turn,
-- and it never offered anyone a slot: `availableSlots` had no production
-- supplier and `customer_calendars` had zero writers. A tested state machine
-- with no data source.
--
-- The model is deliberately RESOURCE-first rather than calendar-first. The
-- catalogue's archetype B is "recurring appointments against chair, room or
-- practitioner capacity", and a salon with three chairs is not one calendar —
-- it is three, and a booking consumes exactly one of them.

CREATE TABLE IF NOT EXISTS scheduling_resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  name          TEXT NOT NULL,             -- "Chair 2", "Room A", "Dave's van"
  kind          TEXT NOT NULL,             -- 'practitioner'|'room'|'equipment'|'crew'
  -- >1 for a class or a course: twelve people share one yoga slot.
  capacity      SMALLINT NOT NULL DEFAULT 1 CHECK (capacity > 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, name)
);

-- When a resource is available, as a weekly pattern in the BUSINESS's timezone.
CREATE TABLE IF NOT EXISTS availability_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  resource_id   UUID REFERENCES scheduling_resources(id),
  weekday       SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_minute  SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute    SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  -- Minutes a booking occupies, and the gap after it. A mobile trade needs
  -- travel time; a salon needs a clean-down.
  slot_minutes  SMALLINT NOT NULL DEFAULT 60 CHECK (slot_minutes > 0),
  buffer_minutes SMALLINT NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  CHECK (end_minute > start_minute)
);
CREATE INDEX IF NOT EXISTS availability_rules_customer ON availability_rules (customer_id, weekday);

-- Holidays, sickness, a booked-out afternoon. Wins over any rule.
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  resource_id   UUID REFERENCES scheduling_resources(id),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  reason        TEXT,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS availability_exceptions_window
  ON availability_exceptions (customer_id, starts_at, ends_at);

-- Someone who wanted a slot that was gone. The catalogue's MF10 lists waitlists
-- explicitly, and a business with no waitlist loses the cancellation refill —
-- which is the single largest recoverable revenue line in archetypes B and G.
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  session_id    UUID REFERENCES agent_sessions(id),
  contact       TEXT NOT NULL,
  earliest_at   TIMESTAMPTZ NOT NULL,
  latest_at     TIMESTAMPTZ NOT NULL,
  resource_id   UUID REFERENCES scheduling_resources(id),
  notified_at   TIMESTAMPTZ,
  filled_booking_id UUID REFERENCES bookings(id),
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (latest_at > earliest_at)
);
CREATE INDEX IF NOT EXISTS waitlist_open
  ON waitlist_entries (customer_id, earliest_at)
  WHERE notified_at IS NULL AND cancelled_at IS NULL AND filled_booking_id IS NULL;

-- Bookings gain a resource, so capacity can be counted.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resource_id UUID REFERENCES scheduling_resources(id);
CREATE INDEX IF NOT EXISTS bookings_resource_window
  ON bookings (resource_id, slot_start, slot_end) WHERE status <> 'cancelled';
