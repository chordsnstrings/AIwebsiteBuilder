-- The enquiry read side (§39): three columns without which a captured enquiry
-- can be written but never chased, closed, or told to anyone.
--
-- ⛔ `enquiries` had rows and no readers. `commitEnquiry` wrote one per session,
-- correctly, and its own comment called the destination "the owner's queue" —
-- but nothing selected from this table anywhere in the repo, no route exposed
-- it, and the dashboard's Enquiries screen rendered demo fixtures. Meanwhile
-- the agent tells the visitor, in words, that it has passed their message on.
-- That is the one place this product actively misleads a member of the public,
-- and it is a missing read, not a missing feature.

-- When the owner was told. NULL means the notification is still owed, which is
-- what the notifier job selects on — so "written" and "delivered" stop being
-- the same state.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Who closed it and when. `status` already carried open/contacted/closed and
-- nothing could move it off 'open', which is the same defect `exceptions` had:
-- a queue with no writer is a list.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS resolved_by TEXT;

-- ⛔ The two columns must agree. A closed enquiry with no `resolved_at` is
-- indistinguishable from an open one in every time-ordered report, and a
-- resolution with no name attached cannot be questioned later. NOT VALID so the
-- rows that predate the columns are not rewritten; everything written from here
-- is checked.
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_closed_is_attributed;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_closed_is_attributed
  CHECK (status <> 'closed' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)) NOT VALID;

-- ⛔ A denial that retries forever is an alert storm, and a denial that marks
-- the row delivered is a lost enquiry. Neither is acceptable, so the attempt is
-- counted and the last error kept: the notifier stops after a few tries and
-- says why, and the enquiry itself stays open on the dashboard the whole time.
-- The email is the nudge; the dashboard is the record.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS notify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS notify_error TEXT;

-- The notifier's own scan: oldest unnotified first, cheaply.
CREATE INDEX IF NOT EXISTS enquiries_unnotified
  ON enquiries (created_at) WHERE notified_at IS NULL;
